import type {
  FirmwareSimulationInput,
  FirmwareSimulationResult,
  RenodeFirmwareSession,
} from "@tscircuit/renode-firmware-engine"
import { getFirmwareSimulationEngineName } from "./load-firmware-simulation-config"

type RenodeEngineModule = typeof import("@tscircuit/renode-firmware-engine")

let renodeEngineModulePromise: Promise<RenodeEngineModule> | undefined
let renodeRuntimePromise: Promise<unknown> | undefined

const loadRenodeEngineModule = (): Promise<RenodeEngineModule> => {
  renodeEngineModulePromise ??= import("@tscircuit/renode-firmware-engine")
  return renodeEngineModulePromise
}

const assertRenodeEngine = (projectDir: string): void => {
  const engineName = getFirmwareSimulationEngineName(projectDir)
  if (engineName === "renode") return
  if (!engineName) {
    throw new Error(
      "Set firmwareSimulationEngine in tscircuit.config.json before starting firmware simulation",
    )
  }
  throw new Error(`Unsupported firmware simulation engine: ${engineName}`)
}

export const prepareFirmwareSimulationEngine = async (
  projectDir: string,
): Promise<void> => {
  const engineName = getFirmwareSimulationEngineName(projectDir)
  if (!engineName) return
  assertRenodeEngine(projectDir)
  const engineModule = await loadRenodeEngineModule()
  renodeRuntimePromise ??= engineModule.ensureRenodeRuntime({
    onProgress: (message) => console.log(`[firmware] ${message}`),
  })
  await renodeRuntimePromise
}

export const createConfiguredFirmwareSession = async (request: {
  projectDir: string
  input: FirmwareSimulationInput
}): Promise<RenodeFirmwareSession> => {
  assertRenodeEngine(request.projectDir)
  const engineModule = await loadRenodeEngineModule()
  return engineModule.createRenodeFirmwareSession(request.input)
}

export const simulateWithConfiguredFirmwareEngine = async (request: {
  projectDir: string
  input: FirmwareSimulationInput
}): Promise<FirmwareSimulationResult> => {
  assertRenodeEngine(request.projectDir)
  const engineModule = await loadRenodeEngineModule()
  return engineModule.createRenodeFirmwareEngine().simulate(request.input)
}
