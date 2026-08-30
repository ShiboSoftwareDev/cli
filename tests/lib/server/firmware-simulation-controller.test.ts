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
    })`,
  )

  const controller = new FirmwareSimulationController(projectDir, {
    createSession: async (input) => {
      createdInput = input
      return createFakeSession(input)
    },
  })
  expect(controller.getState().display_status).toBe("stopped")

  const created = await controller.create([])
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

  const deleted = await controller.delete()
  expect(deleted.is_running).toBe(false)
  expect(deleted.display_status).toBe("stopped")
})
