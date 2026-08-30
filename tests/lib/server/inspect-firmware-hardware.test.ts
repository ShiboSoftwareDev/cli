import { expect, test } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { appendCopperBridgeTrace } from "@tscircuit/check-shorts"
import type { FirmwareSimulationInput } from "@tscircuit/renode-firmware-engine"
import { getCircuitJsonForCheck } from "cli/check/shared"
import { inspectFirmwareHardware } from "lib/firmware-simulation/inspect-firmware-hardware"
import { temporaryDirectory } from "tempy"

test("reports a routed copper short with its physical location", async () => {
  const projectDir = temporaryDirectory()
  const circuitPath = join(projectDir, "shorted-board.tsx")
  await symlink(
    join(process.cwd(), "node_modules"),
    join(projectDir, "node_modules"),
    "dir",
  )
  await writeFile(
    circuitPath,
    `export default () => (
      <board width="10mm" height="10mm" routingDisabled>
        <resistor resistance="1k" footprint="0402" name="R1" pcbX={-2} pcbY={0} />
        <capacitor capacitance="1nF" footprint="0402" name="C1" pcbX={2} pcbY={0} />
      </board>
    )`,
  )
  const circuitJson = appendCopperBridgeTrace(
    await getCircuitJsonForCheck({
      filePath: circuitPath,
      platformConfig: { pcbDisabled: false, routingDisabled: true },
    }),
    {
      start: { x: -2.2, y: 0 },
      end: { x: 2.2, y: 0 },
      width: 0.25,
    },
  )
  const input: FirmwareSimulationInput = {
    name: "short inspection",
    circuitJson,
    firmware: {
      path: "firmware.elf",
      format: "elf",
      programming: { method: "preloaded" },
    },
    hardware: {
      mcu: { componentName: "U_MISSING" },
      platformRepl: "platform.repl",
      leds: [],
      buttons: [],
    },
    steps: [],
  }

  const inspection = await inspectFirmwareHardware({ circuitJson, input })

  expect(inspection.isComplete).toBe(true)
  expect(inspection.hasErrors).toBe(true)
  expect(inspection.displayStatus).toBe("failed")
  expect(inspection.shorts.length).toBeGreaterThan(0)
  expect(inspection.shorts[0]?.layer).toBe("top")
  expect(inspection.shorts[0]?.x_mm).toBeNumber()
  expect(inspection.shorts[0]?.first_owner_labels.length).toBeGreaterThan(0)
  expect(inspection.shorts[0]?.second_owner_labels.length).toBeGreaterThan(0)
})
