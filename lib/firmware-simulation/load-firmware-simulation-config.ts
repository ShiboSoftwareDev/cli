import path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  FirmwareSimulationInput,
  FirmwareSimulationInputFactory,
  FirmwareWorkbenchConfig,
} from "@tscircuit/renode-firmware-engine"
import type { CircuitJson } from "circuit-json"
import { loadProjectConfig } from "lib/project-config"

export interface LoadedFirmwareSimulationConfig {
  configPath: string
  inputFactory: FirmwareSimulationInputFactory
  firmwareWorkbench?: FirmwareWorkbenchConfig
}

interface FirmwareSimulationConfigModule {
  default?: FirmwareSimulationInputFactory
  firmwareSimulation?: FirmwareSimulationInputFactory
  firmwareWorkbench?: FirmwareWorkbenchConfig
}

const isPathInsideProject = (request: {
  candidatePath: string
  projectDir: string
}): boolean => {
  const relativePath = path.relative(request.projectDir, request.candidatePath)
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

export const getFirmwareSimulationConfigPath = (
  projectDir: string,
): string | undefined => {
  const configuredPath =
    loadProjectConfig(projectDir)?.firmwareSimulationConfigPath
  if (!configuredPath) return undefined
  const configPath = path.resolve(projectDir, configuredPath)
  if (!isPathInsideProject({ candidatePath: configPath, projectDir })) {
    throw new Error(
      "firmwareSimulationConfigPath must resolve inside the project directory",
    )
  }
  return configPath
}

export const loadFirmwareSimulationConfig = async (
  projectDir: string,
): Promise<LoadedFirmwareSimulationConfig> => {
  const configPath = getFirmwareSimulationConfigPath(projectDir)
  if (!configPath) {
    throw new Error(
      "Set firmwareSimulationConfigPath in tscircuit.config.json before starting firmware simulation",
    )
  }
  const configUrl = pathToFileURL(configPath)
  configUrl.searchParams.set("tsci", String(Date.now()))
  const configModule: FirmwareSimulationConfigModule = await import(
    configUrl.href
  )
  const inputFactory = configModule.default ?? configModule.firmwareSimulation
  if (typeof inputFactory !== "function") {
    throw new Error(
      "The firmware simulation config must default-export a defineFirmwareSimulation factory",
    )
  }
  return {
    configPath,
    inputFactory,
    firmwareWorkbench: configModule.firmwareWorkbench,
  }
}

export const loadFirmwareSimulationInput = async (request: {
  projectDir: string
  circuitJson: CircuitJson
}): Promise<FirmwareSimulationInput> => {
  const config = await loadFirmwareSimulationConfig(request.projectDir)
  const input = await config.inputFactory({ circuitJson: request.circuitJson })
  return {
    ...input,
    firmware: {
      ...input.firmware,
      path: path.isAbsolute(input.firmware.path)
        ? input.firmware.path
        : path.resolve(path.dirname(config.configPath), input.firmware.path),
    },
  }
}
