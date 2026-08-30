import { spawn } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  createDockerRenodeFirmwareSession,
  type FirmwareSimulationInput,
  type FirmwareSimulationInputFactory,
  type FirmwareSimulationSessionState,
  type FirmwareWorkbenchConfig,
  type RenodeFirmwareSession,
} from "@tscircuit/renode-firmware-engine"
import type { CircuitJson } from "circuit-json"
import { loadProjectConfig } from "lib/project-config"

type FirmwareDeviceMode = "off" | "sam_ba_bootloader" | "application"
type FirmwareBuildStatus = "not_built" | "building" | "succeeded" | "failed"

interface ResolvedFirmwareWorkbench {
  sourcePath: string
  artifactPath: string
  language: string
  build: {
    command: string
    args: string[]
    workingDirectory: string
    timeoutMilliseconds: number
  }
}

interface FirmwareProjectApiState {
  source_file_path: string
  artifact_file_path: string
  language: string
  build_status: FirmwareBuildStatus
  build_output?: string
  has_build_artifact: boolean
  is_build_current: boolean
}

export interface FirmwareSourceApiState {
  file_path: string
  language: string
  content: string
}

export interface FirmwareSimulationApiState {
  is_configured: boolean
  is_running: boolean
  display_status:
    | "not_configured"
    | "stopped"
    | "building"
    | "programming"
    | "bootloader"
    | "ready"
    | "error"
  firmware_file_path?: string
  mcu_component_name?: string
  usb: {
    is_connected: boolean
    is_powered: boolean
    device_mode: FirmwareDeviceMode
  }
  firmware_project?: FirmwareProjectApiState
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

type RunBuild = (request: {
  command: string
  args: string[]
  workingDirectory: string
  timeoutMilliseconds: number
}) => Promise<{ stdout: string; stderr: string }>

const isPathInside = (candidatePath: string, projectDir: string): boolean => {
  const relativePath = path.relative(projectDir, candidatePath)
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

const isPathInsideOrEqual = (
  candidatePath: string,
  projectDir: string,
): boolean =>
  candidatePath === projectDir || isPathInside(candidatePath, projectDir)

const runBuildProcess: RunBuild = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.workingDirectory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-64 * 1024)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(
        new Error(
          `Firmware build timed out after ${request.timeoutMilliseconds}ms`,
        ),
      )
    }, request.timeoutMilliseconds)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (exitCode) => {
      clearTimeout(timeout)
      if (exitCode === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `Firmware build exited with ${exitCode ?? "no status"}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
        ),
      )
    })
  })

const toApiState = (request: {
  isConfigured: boolean
  isBuilding: boolean
  isProgramming: boolean
  isUsbConnected: boolean
  deviceMode: FirmwareDeviceMode
  input?: FirmwareSimulationInput
  project?: FirmwareProjectApiState
  sessionState?: FirmwareSimulationSessionState
  errorMessage?: string
}): FirmwareSimulationApiState => {
  const { sessionState } = request
  return {
    is_configured: request.isConfigured,
    is_running: sessionState?.isRunning ?? false,
    display_status: request.errorMessage
      ? "error"
      : request.isBuilding
        ? "building"
        : request.isProgramming
          ? "programming"
          : sessionState?.isRunning
            ? "ready"
            : request.isUsbConnected
              ? "bootloader"
              : request.isConfigured
                ? "stopped"
                : "not_configured",
    usb: {
      is_connected: request.isUsbConnected,
      is_powered: request.isUsbConnected,
      device_mode: request.deviceMode,
    },
    ...(request.project ? { firmware_project: request.project } : {}),
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
  private workbench?: ResolvedFirmwareWorkbench
  private isUsbConnected = false
  private deviceMode: FirmwareDeviceMode = "off"
  private isBuilding = false
  private isProgramming = false
  private buildStatus: FirmwareBuildStatus = "not_built"
  private buildOutput?: string
  private errorMessage?: string
  private operationQueue: Promise<unknown> = Promise.resolve()
  private readonly createSession: CreateSession
  private readonly runBuild: RunBuild

  constructor(
    private readonly projectDir: string,
    options: { createSession?: CreateSession; runBuild?: RunBuild } = {},
  ) {
    this.createSession =
      options.createSession ?? createDockerRenodeFirmwareSession
    this.runBuild = options.runBuild ?? runBuildProcess
  }

  getState(): FirmwareSimulationApiState {
    const state = toApiState({
      isConfigured: this.getConfigPath() !== undefined,
      isBuilding: this.isBuilding,
      isProgramming: this.isProgramming,
      isUsbConnected: this.isUsbConnected,
      deviceMode: this.deviceMode,
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

  async getStateWithProject(): Promise<FirmwareSimulationApiState> {
    const project = await this.getProjectState()
    const state = this.getState()
    if (project) state.firmware_project = project
    return state
  }

  async getSource(): Promise<FirmwareSourceApiState> {
    const workbench = await this.getWorkbench()
    if (!workbench) {
      throw new Error(
        "Export firmwareWorkbench from the firmware simulation config before editing firmware",
      )
    }
    return {
      file_path: path.relative(this.projectDir, workbench.sourcePath),
      language: workbench.language,
      content: await readFile(workbench.sourcePath, "utf8"),
    }
  }

  saveSource(sourceCode: string): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      const workbench = await this.getWorkbench()
      if (!workbench)
        throw new Error("Firmware source editing is not configured")
      await writeFile(workbench.sourcePath, sourceCode, "utf8")
      this.buildStatus = "not_built"
      this.buildOutput = undefined
      this.errorMessage = undefined
      return this.getStateWithProject()
    })
  }

  build(): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      const workbench = await this.getWorkbench()
      if (!workbench) throw new Error("Firmware building is not configured")
      this.isBuilding = true
      this.errorMessage = undefined
      this.buildOutput = undefined
      try {
        const result = await this.runBuild(workbench.build)
        await stat(workbench.artifactPath)
        this.buildStatus = "succeeded"
        this.buildOutput = [result.stdout.trim(), result.stderr.trim()]
          .filter(Boolean)
          .join("\n")
      } catch (error) {
        this.buildStatus = "failed"
        this.errorMessage =
          error instanceof Error ? error.message : "Firmware build failed"
        this.buildOutput = this.errorMessage
        throw error
      } finally {
        this.isBuilding = false
      }
      return this.getStateWithProject()
    })
  }

  connectUsb(): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      this.isUsbConnected = true
      this.deviceMode = this.session ? "application" : "sam_ba_bootloader"
      this.errorMessage = undefined
      return this.getStateWithProject()
    })
  }

  disconnectUsb(): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      await this.stopSession()
      this.isUsbConnected = false
      this.deviceMode = "off"
      this.errorMessage = undefined
      return this.getStateWithProject()
    })
  }

  enterBootloader(): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      if (!this.isUsbConnected) {
        throw new Error("Plug in the USB cable before entering bootloader mode")
      }
      await this.stopSession()
      this.deviceMode = "sam_ba_bootloader"
      this.errorMessage = undefined
      return this.getStateWithProject()
    })
  }

  program(circuitJson: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      if (!this.isUsbConnected) {
        throw new Error("Plug in the USB cable before programming firmware")
      }
      if (this.deviceMode !== "sam_ba_bootloader") {
        throw new Error("Enter SAM-BA bootloader mode before programming")
      }
      const project = await this.getProjectState()
      if (
        project &&
        (!project.has_build_artifact || !project.is_build_current)
      ) {
        throw new Error("Build the current firmware source before programming")
      }
      this.isProgramming = true
      this.errorMessage = undefined
      try {
        await this.stopSession()
        this.input = await this.loadInput(circuitJson)
        this.session = await this.createSession(this.input)
        this.sessionState = await this.session.getState()
        this.deviceMode = "application"
      } catch (error) {
        this.errorMessage =
          error instanceof Error ? error.message : "Firmware simulation failed"
        this.deviceMode = "sam_ba_bootloader"
        throw error
      } finally {
        this.isProgramming = false
      }
      return this.getStateWithProject()
    })
  }

  create(circuitJson: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.program(circuitJson)
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
        return this.getStateWithProject()
      } catch (error) {
        this.errorMessage =
          error instanceof Error ? error.message : "Firmware simulation failed"
        throw error
      }
    })
  }

  delete(): Promise<FirmwareSimulationApiState> {
    return this.disconnectUsb()
  }

  private async getProjectState(): Promise<
    FirmwareProjectApiState | undefined
  > {
    const workbench = await this.getWorkbench()
    if (!workbench) return undefined
    const [sourceMetadata, artifactMetadata] = await Promise.all([
      stat(workbench.sourcePath).catch(() => undefined),
      stat(workbench.artifactPath).catch(() => undefined),
    ])
    const hasBuildArtifact = artifactMetadata?.isFile() === true
    const isBuildCurrent =
      hasBuildArtifact &&
      sourceMetadata !== undefined &&
      artifactMetadata.mtimeMs >= sourceMetadata.mtimeMs
    const buildStatus = this.isBuilding
      ? "building"
      : this.buildStatus === "failed"
        ? "failed"
        : isBuildCurrent
          ? "succeeded"
          : "not_built"
    return {
      source_file_path: path.relative(this.projectDir, workbench.sourcePath),
      artifact_file_path: path.relative(
        this.projectDir,
        workbench.artifactPath,
      ),
      language: workbench.language,
      build_status: buildStatus,
      ...(this.buildOutput ? { build_output: this.buildOutput } : {}),
      has_build_artifact: hasBuildArtifact,
      is_build_current: isBuildCurrent,
    }
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

  private async loadConfigModule(): Promise<Record<string, unknown>> {
    const configPath = this.getConfigPath()
    if (!configPath) {
      throw new Error(
        "Set firmwareSimulationConfigPath in tscircuit.config.json before starting firmware simulation",
      )
    }
    const configUrl = pathToFileURL(configPath)
    configUrl.searchParams.set("tsci", String(Date.now()))
    return (await import(configUrl.href)) as Record<string, unknown>
  }

  private async getWorkbench(): Promise<ResolvedFirmwareWorkbench | undefined> {
    if (this.workbench) return this.workbench
    const configPath = this.getConfigPath()
    if (!configPath) return undefined
    const configModule = await this.loadConfigModule()
    const workbench = configModule.firmwareWorkbench as
      | FirmwareWorkbenchConfig
      | undefined
    if (!workbench) return undefined
    const configDirectory = path.dirname(configPath)
    const sourcePath = path.resolve(configDirectory, workbench.sourcePath)
    const artifactPath = path.resolve(configDirectory, workbench.artifactPath)
    const workingDirectory = path.resolve(
      configDirectory,
      workbench.build.workingDirectory ?? ".",
    )
    for (const [description, candidatePath] of [
      ["Firmware source", sourcePath],
      ["Firmware artifact", artifactPath],
      ["Firmware build working directory", workingDirectory],
    ] as const) {
      if (!isPathInsideOrEqual(candidatePath, this.projectDir)) {
        throw new Error(
          `${description} must resolve inside the project directory`,
        )
      }
    }
    if (!workbench.build.command.trim()) {
      throw new Error("Firmware build command is required")
    }
    this.workbench = {
      sourcePath,
      artifactPath,
      language: workbench.language ?? "text",
      build: {
        command: workbench.build.command,
        args: workbench.build.args ?? [],
        workingDirectory,
        timeoutMilliseconds: workbench.build.timeoutMilliseconds ?? 30_000,
      },
    }
    return this.workbench
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
    const configModule = await this.loadConfigModule()
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
