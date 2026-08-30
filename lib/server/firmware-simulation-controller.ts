import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  createDockerRenodeFirmwareSession,
  type FirmwareSimulationInput,
  type FirmwareSimulationInputFactory,
  type FirmwareSimulationSessionState,
  type RenodeFirmwareSession,
} from "@tscircuit/renode-firmware-engine"
import type { CircuitJson } from "circuit-json"
import { loadProjectConfig } from "lib/project-config"

export interface FirmwareSimulationApiState {
  is_configured: boolean
  is_running: boolean
  display_status:
    | "not_configured"
    | "stopped"
    | "programming"
    | "ready"
    | "error"
  firmware_file_path?: string
  mcu_component_name?: string
  programming?: {
    method: "usb_sam_ba"
    bytes_written: number
    sha256: string
    is_verified: boolean
  }
  buttons: Array<{
    component_name: string
    is_pressed: boolean
  }>
  leds: Array<{
    component_name: string
    is_on: boolean
  }>
  virtual_time_ms: number
  error_message?: string
}

type CreateSession = (
  input: FirmwareSimulationInput,
) => Promise<RenodeFirmwareSession>

const isPathInside = (candidatePath: string, projectDir: string): boolean => {
  const relativePath = path.relative(projectDir, candidatePath)
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

const toApiState = (request: {
  isConfigured: boolean
  isProgramming: boolean
  input?: FirmwareSimulationInput
  sessionState?: FirmwareSimulationSessionState
  errorMessage?: string
}): FirmwareSimulationApiState => {
  const { sessionState } = request
  return {
    is_configured: request.isConfigured,
    is_running: sessionState?.isRunning ?? false,
    display_status: request.errorMessage
      ? "error"
      : request.isProgramming
        ? "programming"
        : sessionState?.isRunning
          ? "ready"
          : request.isConfigured
            ? "stopped"
            : "not_configured",
    ...(request.input
      ? {
          firmware_file_path: request.input.firmware.path,
          mcu_component_name: request.input.hardware.mcu.componentName,
        }
      : {}),
    ...(sessionState
      ? {
          programming: {
            method: sessionState.programming.method,
            bytes_written: sessionState.programming.bytesWritten,
            sha256: sessionState.programming.sha256,
            is_verified: sessionState.programming.isVerified,
          },
          buttons: Object.entries(sessionState.buttonStates).map(
            ([componentName, isPressed]) => ({
              component_name: componentName,
              is_pressed: isPressed,
            }),
          ),
          leds: Object.entries(sessionState.ledStates).map(
            ([componentName, isOn]) => ({
              component_name: componentName,
              is_on: isOn,
            }),
          ),
          virtual_time_ms: sessionState.virtualTimeMilliseconds,
        }
      : {
          buttons: [],
          leds: [],
          virtual_time_ms: 0,
        }),
    ...(request.errorMessage ? { error_message: request.errorMessage } : {}),
  }
}

export class FirmwareSimulationController {
  private session?: RenodeFirmwareSession
  private sessionState?: FirmwareSimulationSessionState
  private input?: FirmwareSimulationInput
  private isProgramming = false
  private errorMessage?: string
  private operationQueue: Promise<unknown> = Promise.resolve()
  private readonly createSession: CreateSession

  constructor(
    private readonly projectDir: string,
    options: { createSession?: CreateSession } = {},
  ) {
    this.createSession =
      options.createSession ?? createDockerRenodeFirmwareSession
  }

  getState(): FirmwareSimulationApiState {
    const state = toApiState({
      isConfigured: this.getConfigPath() !== undefined,
      isProgramming: this.isProgramming,
      input: this.input,
      sessionState: this.sessionState,
      errorMessage: this.errorMessage,
    })
    if (state.firmware_file_path && path.isAbsolute(state.firmware_file_path)) {
      state.firmware_file_path = path.relative(
        this.projectDir,
        state.firmware_file_path,
      )
    }
    return state
  }

  create(circuitJson: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      this.isProgramming = true
      this.errorMessage = undefined
      try {
        await this.stopSession()
        this.input = await this.loadInput(circuitJson)
        this.session = await this.createSession(this.input)
        this.sessionState = await this.session.getState()
      } catch (error) {
        this.errorMessage =
          error instanceof Error ? error.message : "Firmware simulation failed"
        throw error
      } finally {
        this.isProgramming = false
      }
      return this.getState()
    })
  }

  update(request: {
    buttonComponentName?: string
    isPressed?: boolean
    advanceTimeMs?: number
  }): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      if (!this.session) throw new Error("No firmware simulation is running")
      this.errorMessage = undefined
      try {
        if (request.buttonComponentName !== undefined) {
          if (request.isPressed === undefined) {
            throw new Error("Button updates require is_pressed")
          }
          this.sessionState = await this.session.setButton({
            componentName: request.buttonComponentName,
            isPressed: request.isPressed,
          })
        } else if (request.advanceTimeMs !== undefined) {
          this.sessionState = await this.session.runFor(request.advanceTimeMs)
        } else {
          throw new Error("A firmware simulation update action is required")
        }
        return this.getState()
      } catch (error) {
        this.errorMessage =
          error instanceof Error ? error.message : "Firmware simulation failed"
        throw error
      }
    })
  }

  delete(): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      await this.stopSession()
      this.errorMessage = undefined
      return this.getState()
    })
  }

  private async stopSession(): Promise<void> {
    await this.session?.stop()
    this.session = undefined
    this.sessionState = undefined
  }

  private getConfigPath(): string | undefined {
    const configPath = loadProjectConfig(
      this.projectDir,
    )?.firmwareSimulationConfigPath
    if (!configPath) return undefined
    const resolvedConfigPath = path.resolve(this.projectDir, configPath)
    if (!isPathInside(resolvedConfigPath, this.projectDir)) {
      throw new Error(
        "firmwareSimulationConfigPath must resolve inside the project directory",
      )
    }
    return resolvedConfigPath
  }

  private async loadInput(
    circuitJson: CircuitJson,
  ): Promise<FirmwareSimulationInput> {
    const configPath = this.getConfigPath()
    if (!configPath) {
      throw new Error(
        "Set firmwareSimulationConfigPath in tscircuit.config.json before starting firmware simulation",
      )
    }
    const configUrl = pathToFileURL(configPath)
    configUrl.searchParams.set("tsci", String(Date.now()))
    const configModule = await import(configUrl.href)
    const inputFactory = (configModule.default ??
      configModule.firmwareSimulation) as unknown
    if (typeof inputFactory !== "function") {
      throw new Error(
        "The firmware simulation config must default-export a defineFirmwareSimulation factory",
      )
    }
    const input = await (inputFactory as FirmwareSimulationInputFactory)({
      circuitJson,
    })
    return {
      ...input,
      firmware: {
        ...input.firmware,
        path: path.isAbsolute(input.firmware.path)
          ? input.firmware.path
          : path.resolve(path.dirname(configPath), input.firmware.path),
      },
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.catch(() => undefined)
    return result
  }
}
