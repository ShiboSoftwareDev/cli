import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runFirmwareSimulation } from "lib/firmware-simulation/run-firmware-simulation"

test("builds the configured firmware before inspection and simulation", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "tsci-firmware-command-"))
  await writeFile(
    join(projectDir, "tscircuit.config.json"),
    JSON.stringify({
      firmwareSimulationEngine: "renode",
      firmwareSimulationConfigPath: "firmware-simulation.js",
    }),
  )
  await writeFile(join(projectDir, "main.c"), "int main(void) { return 0; }")
  await writeFile(
    join(projectDir, "firmware-simulation.js"),
    `export default ({ circuitJson }) => ({
      name: "firmware command fixture",
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
      sourcePath: "main.c",
      artifactPath: "firmware.bin",
      language: "c",
      build: { command: "fixture-build" }
    }`,
  )

  const operations: string[] = []
  const result = await runFirmwareSimulation(
    { projectDir, circuitJson: [] },
    {
      runBuild: async () => {
        operations.push("build")
        await writeFile(join(projectDir, "firmware.bin"), "built artifact")
        return { stdout: "built", stderr: "" }
      },
      inspectHardware: async () => {
        operations.push("inspect")
        expect(await readFile(join(projectDir, "firmware.bin"), "utf8")).toBe(
          "built artifact",
        )
        return {
          isComplete: true,
          hasErrors: false,
          displayStatus: "passed",
          issues: [],
          shorts: [],
        }
      },
      simulate: async () => {
        operations.push("simulate")
        return {
          isPassing: true,
          displayStatus: "passed",
          tests: [],
          stdout: "",
          stderr: "",
          durationMilliseconds: 1,
        }
      },
    },
  )

  expect(operations).toEqual(["build", "inspect", "simulate"])
  expect(result.isPassing).toBe(true)
})
