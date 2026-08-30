import type { PlatformConfig } from "@tscircuit/props"
import { runFirmwareSimulation } from "lib/firmware-simulation/run-firmware-simulation"
import { loadRuntimeProjectConfig } from "lib/project-config"
import { findCircuitProjectDir } from "lib/shared/circuit-json-build-cache"
import { getOrGenerateCircuitJson } from "lib/shared/get-or-generate-circuit-json"
import { getPlatformConfigWithCliDefaults } from "lib/shared/get-platform-config-with-cli-defaults"
import { mergePlatformConfigs } from "lib/shared/platform-config-utils"

const printFirmwareSimulationResult = (request: {
  result: Awaited<ReturnType<typeof runFirmwareSimulation>>
}): void => {
  console.log(
    `${request.result.isPassing ? "PASS" : "FAIL"} ${request.result.displayStatus}`,
  )
  for (const firmwareTest of request.result.tests) {
    console.log(
      `${firmwareTest.isPassing ? "PASS" : "FAIL"} ${firmwareTest.name}${firmwareTest.message ? `: ${firmwareTest.message}` : ""}`,
    )
  }
  if (request.result.programming) {
    console.log(
      `Programmed ${request.result.programming.bytesWritten} bytes over ${request.result.programming.method}`,
    )
    console.log(`SHA-256 ${request.result.programming.sha256}`)
  }
  if (request.result.stdout.trim()) console.log(request.result.stdout.trim())
  if (request.result.stderr.trim()) console.error(request.result.stderr.trim())
}

export const runFirmwareSimulationCommand = async (request: {
  file: string
  options: { disablePartsEngine?: boolean }
}): Promise<void> => {
  const projectDir = findCircuitProjectDir(request.file)
  const projectConfig = await loadRuntimeProjectConfig(process.cwd())
  const commandPlatformConfig: PlatformConfig | undefined =
    request.options.disablePartsEngine === true
      ? { partsEngineDisabled: true }
      : undefined
  const platformConfig = mergePlatformConfigs(
    projectConfig?.platformConfig,
    commandPlatformConfig,
  )
  const { circuitJson } = await getOrGenerateCircuitJson({
    filePath: request.file,
    saveToFile: false,
    platformConfig: getPlatformConfigWithCliDefaults(platformConfig, {
      projectDir,
    }),
  })
  if (!circuitJson) throw new Error("Failed to generate Circuit JSON")
  const result = await runFirmwareSimulation({ projectDir, circuitJson })
  printFirmwareSimulationResult({ result })
  if (!result.isPassing) process.exitCode = 1
}
