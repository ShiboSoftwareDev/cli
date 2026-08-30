import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  FirmwareSimulationInput,
  FirmwareSimulationSessionState,
  RenodeFirmwareSession,
} from "@tscircuit/renode-firmware-engine"
import type { CircuitJson } from "circuit-json"
import {
  type ResolvedFirmwareWorkbench,
  type RunFirmwareBuild,
  resolveFirmwareWorkbench,
  runFirmwareBuildProcess,
} from "lib/firmware-simulation/firmware-workbench"
import {
  getFirmwareSimulationConfigPath,
  isFirmwareSimulationConfigured,
  loadFirmwareSimulationInput,
} from "lib/firmware-simulation/load-firmware-simulation-config"
import { createConfiguredFirmwareSession } from "lib/firmware-simulation/load-firmware-simulation-engine"
import {
  type FirmwareHardwareInspection,
  inspectFirmwareHardware,
} from "lib/firmware-simulation/inspect-firmware-hardware"
import type {
  FirmwareBuildDisplayStatus,
  FirmwareDeviceMode,
  FirmwareProjectApiState,
  FirmwareSimulationApiState,
  FirmwareSourceApiState,
  FirmwareUsbDisplayStatus,
} from "./firmware-simulation-api-types"
import { getFirmwareSimulationApiState } from "./get-firmware-simulation-api-state"

type CreateSession = (
  input: FirmwareSimulationInput,
) => Promise<RenodeFirmwareSession>

type InspectHardware = typeof inspectFirmwareHardware

export class FirmwareSimulationController {
  private session?: RenodeFirmwareSession
  private sessionState?: FirmwareSimulationSessionState
  private input?: FirmwareSimulationInput
  private physicalButtons: FirmwareSimulationSessionState["buttons"] = []
  private workbench?: ResolvedFirmwareWorkbench
  private isUsbConnected = false
  private isUsbPowered = false
  private usbDisplayStatus: FirmwareUsbDisplayStatus = "disconnected"
  private deviceMode: FirmwareDeviceMode = "off"
  private hardwareInspection?: FirmwareHardwareInspection
  private inspectedCircuitHash?: string
  private lastResetPressAt?: number
  private isBuilding = false
  private isProgramming = false
  private buildDisplayStatus: FirmwareBuildDisplayStatus = "not_built"
  private buildOutput?: string
  private errorMessage?: string
  private operationQueue: Promise<unknown> = Promise.resolve()
  private readonly createSession: CreateSession
  private readonly runBuild: RunFirmwareBuild
  private readonly inspectHardware: InspectHardware

  constructor(
    private readonly projectDir: string,
    options: {
      createSession?: CreateSession
      runBuild?: RunFirmwareBuild
      inspectHardware?: InspectHardware
    } = {},
  ) {
    this.createSession =
      options.createSession ??
      ((input) =>
        createConfiguredFirmwareSession({ projectDir: this.projectDir, input }))
    this.runBuild = options.runBuild ?? runFirmwareBuildProcess
    this.inspectHardware = options.inspectHardware ?? inspectFirmwareHardware
  }

  getState(): FirmwareSimulationApiState {
    const state = getFirmwareSimulationApiState({
      isConfigured: isFirmwareSimulationConfigured(this.projectDir),
      isBuilding: this.isBuilding,
      isProgramming: this.isProgramming,
      isUsbConnected: this.isUsbConnected,
      isUsbPowered: this.isUsbPowered,
      usbDisplayStatus: this.usbDisplayStatus,
      deviceMode: this.deviceMode,
      hardwareInspection: this.hardwareInspection,
      resetPressRegistered: this.isResetPressRegistered(),
      input: this.input,
      physicalButtons: this.physicalButtons,
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

  refresh(circuitJson?: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      if (circuitJson) await this.loadInput(circuitJson)
      await this.syncSessionToWallClock()
      return this.getStateWithProject()
    })
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
      this.buildDisplayStatus = "not_built"
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
        this.buildDisplayStatus = "succeeded"
        this.buildOutput = [result.stdout.trim(), result.stderr.trim()]
          .filter(Boolean)
          .join("\n")
      } catch (error) {
        this.buildDisplayStatus = "failed"
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

  connectUsb(circuitJson: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      this.isUsbConnected = true
      this.errorMessage = undefined
      const inspection = await this.inspectCircuit(circuitJson, true)
      if (inspection.hasErrors) {
        const hasOvercurrentFault =
          inspection.shorts.length > 0 ||
          inspection.issues.some((issue) => /shorted/i.test(issue))
        const hasPowerPathFault = inspection.issues.some((issue) =>
          /\b(VBUS|GND|regulator|MCU power|MCU ground|power port)\b/i.test(
            issue,
          ),
        )
        if (this.session) this.sessionState = await this.session.powerOff()
        this.isUsbPowered = !hasOvercurrentFault && !hasPowerPathFault
        this.usbDisplayStatus = hasOvercurrentFault
          ? "overcurrent_fault"
          : "hardware_fault"
        this.deviceMode = "off"
        return this.getStateWithProject()
      }
      this.isUsbPowered = true
      this.usbDisplayStatus = "powered"
      if (this.session) {
        this.sessionState = await this.session.powerOn()
        await this.applyPhysicalButtonsToSession()
        this.deviceMode = "application"
      } else {
        this.deviceMode = "sam_ba_bootloader"
      }
      return this.getStateWithProject()
    })
  }

  disconnectUsb(): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      if (this.session) this.sessionState = await this.session.powerOff()
      this.isUsbConnected = false
      this.isUsbPowered = false
      this.usbDisplayStatus = "disconnected"
      this.deviceMode = "off"
      this.lastResetPressAt = undefined
      this.errorMessage = undefined
      return this.getStateWithProject()
    })
  }

  pressReset(circuitJson: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      await this.loadInput(circuitJson)
      const reset = this.input?.hardware.reset
      if (!reset) {
        throw new Error("No physical reset switch is declared for this board")
      }
      this.errorMessage = undefined
      if (!this.isUsbPowered) {
        this.lastResetPressAt = undefined
        return this.getStateWithProject()
      }
      if (this.deviceMode === "sam_ba_bootloader") {
        if (this.session) {
          this.sessionState = await this.session.powerOn()
          await this.applyPhysicalButtonsToSession()
          this.deviceMode = "application"
        }
        this.lastResetPressAt = undefined
        return this.getStateWithProject()
      }
      if (this.deviceMode !== "application" || !this.session) {
        return this.getStateWithProject()
      }
      const now = Date.now()
      const maxInterval =
        reset.bootloaderEntry?.maxIntervalMilliseconds ?? 1_000
      if (
        reset.bootloaderEntry?.method === "double_press" &&
        this.lastResetPressAt !== undefined &&
        now - this.lastResetPressAt <= maxInterval
      ) {
        this.sessionState = await this.session.powerOff()
        this.deviceMode = "sam_ba_bootloader"
        this.lastResetPressAt = undefined
        return this.getStateWithProject()
      }
      await this.syncSessionToWallClock()
      this.sessionState = await this.session.reset()
      await this.applyPhysicalButtonsToSession()
      this.lastResetPressAt = now
      return this.getStateWithProject()
    })
  }

  program(circuitJson: CircuitJson): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      if (!this.isUsbConnected) {
        throw new Error("USB_PROGRAMMER: NO_DEVICE (USB disconnected)")
      }
      if (this.deviceMode !== "sam_ba_bootloader") {
        throw new Error("USB_PROGRAMMER: SAM_BA_NOT_ENUMERATED")
      }
      const inspection = await this.inspectCircuit(circuitJson)
      if (inspection.hasErrors) {
        throw new Error("USB_PROGRAMMER: HARDWARE_DRC_FAILED")
      }
      if (!this.isUsbPowered) throw new Error("USB_PROGRAMMER: VBUS_ABSENT")
      const project = await this.getProjectState()
      if (
        project &&
        (!project.has_build_artifact || !project.is_build_current)
      ) {
        throw new Error("USB_PROGRAMMER: ARTIFACT_MISSING_OR_STALE")
      }
      this.isProgramming = true
      this.errorMessage = undefined
      try {
        await this.stopSession()
        this.input = await this.loadInput(circuitJson)
        this.session = await this.createSession(this.input)
        this.sessionState = await this.session.getState()
        await this.applyPhysicalButtonsToSession()
        this.isUsbPowered = true
        this.usbDisplayStatus = "powered"
        this.deviceMode = "application"
        this.lastResetPressAt = undefined
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
  }): Promise<FirmwareSimulationApiState> {
    return this.runExclusive(async () => {
      this.errorMessage = undefined
      try {
        if (request.buttonComponentName === undefined) {
          throw new Error("A physical switch action is required")
        }
        if (request.isPressed === undefined) {
          throw new Error("Button updates require is_pressed")
        }
        const physicalButton = this.physicalButtons.find(
          (button) => button.componentName === request.buttonComponentName,
        )
        if (!physicalButton) {
          throw new Error(
            `Physical switch ${request.buttonComponentName} is not declared`,
          )
        }
        physicalButton.isPressed = request.isPressed
        if (
          this.session &&
          this.isUsbPowered &&
          this.deviceMode === "application"
        ) {
          await this.syncSessionToWallClock()
          this.sessionState = await this.session.setButton({
            componentName: request.buttonComponentName,
            isPressed: request.isPressed,
          })
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
    return this.runExclusive(async () => {
      await this.stopSession()
      this.isUsbConnected = false
      this.isUsbPowered = false
      this.usbDisplayStatus = "disconnected"
      this.deviceMode = "off"
      this.lastResetPressAt = undefined
      return this.getStateWithProject()
    })
  }

  private async inspectCircuit(
    circuitJson: CircuitJson,
    force = false,
  ): Promise<FirmwareHardwareInspection> {
    const circuitHash = createHash("sha256")
      .update(JSON.stringify(circuitJson))
      .digest("hex")
    if (
      !force &&
      this.inspectedCircuitHash === circuitHash &&
      this.hardwareInspection
    ) {
      return this.hardwareInspection
    }
    this.input = await this.loadInput(circuitJson)
    this.hardwareInspection = await this.inspectHardware({
      circuitJson,
      input: this.input,
    })
    this.inspectedCircuitHash = circuitHash
    return this.hardwareInspection
  }

  private isResetPressRegistered(): boolean {
    if (this.lastResetPressAt === undefined) return false
    const maxInterval =
      this.input?.hardware.reset?.bootloaderEntry?.maxIntervalMilliseconds ??
      1_000
    return Date.now() - this.lastResetPressAt <= maxInterval
  }

  private async syncSessionToWallClock(): Promise<void> {
    if (
      !this.session ||
      !this.isUsbPowered ||
      this.deviceMode !== "application"
    ) {
      return
    }
    this.sessionState = await this.session.getState()
  }

  private async loadInput(
    circuitJson: CircuitJson,
  ): Promise<FirmwareSimulationInput> {
    const input = await loadFirmwareSimulationInput({
      projectDir: this.projectDir,
      circuitJson,
    })
    this.input = input
    this.physicalButtons = input.hardware.buttons.map((button) => ({
      componentName: button.componentName,
      isPressed:
        this.physicalButtons.find(
          (physicalButton) =>
            physicalButton.componentName === button.componentName,
        )?.isPressed ?? false,
    }))
    return input
  }

  private async applyPhysicalButtonsToSession(): Promise<void> {
    if (!this.session || !this.isUsbPowered) return
    for (const button of this.physicalButtons) {
      this.sessionState = await this.session.setButton(button)
    }
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
    const buildDisplayStatus = this.isBuilding
      ? "building"
      : this.buildDisplayStatus === "failed"
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
      is_building: this.isBuilding,
      has_build_errors: buildDisplayStatus === "failed",
      display_status: buildDisplayStatus,
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

  private async getWorkbench(): Promise<ResolvedFirmwareWorkbench | undefined> {
    if (this.workbench) return this.workbench
    if (!getFirmwareSimulationConfigPath(this.projectDir)) return undefined
    this.workbench = await resolveFirmwareWorkbench(this.projectDir)
    return this.workbench
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.catch(() => undefined)
    return result
  }
}
