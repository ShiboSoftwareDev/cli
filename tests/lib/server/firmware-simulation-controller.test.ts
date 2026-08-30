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

const programming = {
  method: "usb_sam_ba" as const,
  bytesWritten: 324,
  sha256: "fixture-sha256",
  isVerified: true,
}

const createFakeSession = async (
  _input: FirmwareSimulationInput,
): Promise<RenodeFirmwareSession> => {
  let isRunning = true
  let buttonStates = { SW1: false }
  let ledStates = { LED1: false }
  let virtualTimeMilliseconds = 1
  const getState = async (): Promise<FirmwareSimulationSessionState> => ({
    isRunning,
    displayStatus: isRunning ? "ready" : "stopped",
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
    stop: async () => {
      isRunning = false
    },
  }
}

test("creates, updates, and deletes a firmware simulation session", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "tsci-firmware-controller-"))
  let createdInput: FirmwareSimulationInput | undefined
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
        buttons: []
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

  const connected = await controller.connectUsb()
  expect(connected.usb).toEqual({
    is_connected: true,
    is_powered: true,
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

  const advanced = await controller.update({ advanceTimeMs: 10 })
  expect(advanced.virtual_time_ms).toBe(12)

  const bootloader = await controller.enterBootloader()
  expect(bootloader.display_status).toBe("bootloader")
  expect(bootloader.usb.device_mode).toBe("sam_ba_bootloader")

  const deleted = await controller.disconnectUsb()
  expect(deleted.is_running).toBe(false)
  expect(deleted.display_status).toBe("stopped")
  expect(deleted.usb.is_connected).toBe(false)
})
