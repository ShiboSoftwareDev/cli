import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  FirmwareSimulationInput,
  FirmwareSimulationSessionState,
  RenodeFirmwareSession,
} from "@tscircuit/renode-firmware-engine"
import { FirmwareSimulationController } from "lib/server/firmware-simulation-controller"
import type { FirmwareHardwareInspection } from "lib/server/inspect-firmware-hardware"

const programming = {
  method: "usb_sam_ba" as const,
  bytesWritten: 324,
  sha256: "fixture-sha256",
  isVerified: true,
}

const createFakeSession = async (
  _input: FirmwareSimulationInput,
): Promise<RenodeFirmwareSession> => {
  let isPowered = true
  let buttonStates = { SW1: false }
  let ledStates = { LED1: false }
  let virtualTimeMilliseconds = 1
  const getState = async (): Promise<FirmwareSimulationSessionState> => ({
    isRunning: isPowered,
    isPowered,
    displayStatus: isPowered ? "ready" : "stopped",
    programming,
    buttonStates,
    ledStates,
    virtualTimeMilliseconds,
  })
  return {
    programming,
    getState,
    setButton: async ({ isPressed }) => {
      buttonStates = { SW1: isPressed }
      ledStates = { LED1: isPressed }
      virtualTimeMilliseconds += 1
      return getState()
    },
    runFor: async (milliseconds) => {
      virtualTimeMilliseconds += milliseconds
      return getState()
    },
    reset: async () => {
      buttonStates = { SW1: false }
      ledStates = { LED1: false }
      virtualTimeMilliseconds += 1
      return getState()
    },
    powerOff: async () => {
      isPowered = false
      return getState()
    },
    powerOn: async () => {
      isPowered = true
      buttonStates = { SW1: false }
      ledStates = { LED1: false }
      virtualTimeMilliseconds += 1
      return getState()
    },
    stop: async () => {
      isPowered = false
    },
  }
}

test("creates, updates, and deletes a firmware simulation session", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "tsci-firmware-controller-"))
  let createdInput: FirmwareSimulationInput | undefined
  let hardwareInspection: FirmwareHardwareInspection = {
    status: "passed",
    issues: [],
    shorts: [],
  }
  await writeFile(
    join(projectDir, "tscircuit.config.json"),
    JSON.stringify({
      firmwareSimulationConfigPath: "firmware-simulation.js",
    }),
  )
  await writeFile(
    join(projectDir, "firmware-simulation.js"),
    `export default ({ circuitJson }) => ({
      name: "fixture",
      circuitJson,
      firmware: {
        path: "firmware.bin",
        format: "binary",
        programming: { method: "usb_sam_ba", loadAddress: 8192 },
        stackPointer: 536887296,
        entryPoint: 8448
      },
      hardware: {
        mcu: { componentName: "U1" },
        platformRepl: "platform.repl",
        leds: [],
        buttons: [],
        reset: {
          componentName: "SW_RESET",
          mcuPortName: "RESET",
          signalPortName: "pin1",
          referencePortName: "pin2",
          referenceNetName: "GND",
          pullResistorComponentName: "R_RESET",
          pullReferenceNetName: "VCC",
          bootloaderEntry: { method: "double_press", maxIntervalMilliseconds: 1000 }
        }
      },
      steps: []
    })
    export const firmwareWorkbench = {
      sourcePath: "main.S",
      artifactPath: "firmware.bin",
      language: "arm-assembly",
      build: { command: "fake-build", args: ["main.S"] }
    }`,
  )
  await writeFile(join(projectDir, "main.S"), "initial source")

  const controller = new FirmwareSimulationController(projectDir, {
    createSession: async (input) => {
      createdInput = input
      return createFakeSession(input)
    },
    runBuild: async () => {
      await writeFile(join(projectDir, "firmware.bin"), "built firmware")
      return { stdout: "Built firmware.bin", stderr: "" }
    },
    inspectHardware: async () => hardwareInspection,
  })
  expect(controller.getState().display_status).toBe("stopped")

  const initial = await controller.getStateWithProject()
  expect(initial.firmware_project?.build_status).toBe("not_built")
  expect((await controller.getSource()).content).toBe("initial source")

  const saved = await controller.saveSource("updated source")
  expect(saved.firmware_project?.is_build_current).toBe(false)

  const built = await controller.build()
  expect(built.firmware_project?.build_status).toBe("succeeded")
  expect(built.firmware_project?.build_output).toBe("Built firmware.bin")

  const connected = await controller.connectUsb([])
  expect(connected.usb).toEqual({
    is_connected: true,
    is_powered: true,
    is_enumerated: true,
    port_status: "powered",
    device_mode: "sam_ba_bootloader",
  })

  const created = await controller.program([])
  expect(created.display_status).toBe("ready")
  expect(createdInput?.firmware.path).toBe(join(projectDir, "firmware.bin"))
  expect(created.firmware_file_path).toBe("firmware.bin")
  expect(created.programming?.bytes_written).toBe(324)
  expect(created.leds).toEqual([{ component_name: "LED1", is_on: false }])

  const pressed = await controller.update({
    buttonComponentName: "SW1",
    isPressed: true,
  })
  expect(pressed.buttons).toEqual([{ component_name: "SW1", is_pressed: true }])
  expect(pressed.leds).toEqual([{ component_name: "LED1", is_on: true }])

  const unplugged = await controller.disconnectUsb()
  expect(unplugged.usb.is_powered).toBe(false)
  expect(unplugged.is_running).toBe(false)

  const reconnected = await controller.connectUsb([])
  expect(reconnected.usb.device_mode).toBe("application")
  expect(reconnected.is_running).toBe(true)

  const firstReset = await controller.pressReset([])
  expect(firstReset.reset_control?.presses_registered).toBe(1)
  expect(firstReset.usb.device_mode).toBe("application")

  const bootloader = await controller.pressReset([])
  expect(bootloader.display_status).toBe("bootloader")
  expect(bootloader.usb.device_mode).toBe("sam_ba_bootloader")

  const reprogrammed = await controller.program([])
  expect(reprogrammed.is_running).toBe(true)

  const deleted = await controller.delete()
  expect(deleted.is_running).toBe(false)
  expect(deleted.display_status).toBe("stopped")
  expect(deleted.usb.is_connected).toBe(false)

  hardwareInspection = {
    status: "failed",
    issues: [],
    shorts: [
      {
        layer: "top",
        x_mm: 1.25,
        y_mm: -2.5,
        first_owner_labels: ["VBUS"],
        second_owner_labels: ["GND"],
        pixel_count: 8,
      },
    ],
  }
  const shorted = await controller.connectUsb([])
  expect(shorted.display_status).toBe("power_fault")
  expect(shorted.usb.is_connected).toBe(true)
  expect(shorted.usb.is_powered).toBe(false)
  expect(shorted.usb.port_status).toBe("overcurrent_fault")
  expect(shorted.hardware_check.shorts[0]?.first_owner_labels).toEqual(["VBUS"])
})
