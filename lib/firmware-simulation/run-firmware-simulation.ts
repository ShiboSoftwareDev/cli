import {
  createDockerRenodeRunner,
  createRenodeFirmwareEngine,
  type FirmwareSimulationInput,
  type FirmwareSimulationResult,
} from "@tscircuit/renode-firmware-engine"
import type { CircuitJson } from "circuit-json"
import { stat } from "node:fs/promises"
import {
  type RunFirmwareBuild,
  resolveFirmwareWorkbench,
  runFirmwareBuildProcess,
} from "./firmware-workbench"
import {
  type FirmwareHardwareInspection,
  inspectFirmwareHardware,
} from "./inspect-firmware-hardware"
import { loadFirmwareSimulationInput } from "./load-firmware-simulation-config"

interface FirmwareSimulationRuntime {
  runBuild?: RunFirmwareBuild
  inspectHardware?: (request: {
    circuitJson: CircuitJson
    input: FirmwareSimulationInput
  }) => Promise<FirmwareHardwareInspection>
  simulate?: (
    input: FirmwareSimulationInput,
  ) => Promise<FirmwareSimulationResult>
}

const simulateWithDockerRenode = (
  input: FirmwareSimulationInput,
): Promise<FirmwareSimulationResult> => {
  const engine = createRenodeFirmwareEngine({
    runner: createDockerRenodeRunner(),
  })
  return engine.simulate(input)
}

export const runFirmwareSimulation = async (
  request: {
    projectDir: string
    circuitJson: CircuitJson
  },
  runtime: FirmwareSimulationRuntime = {},
): Promise<FirmwareSimulationResult> => {
  const workbench = await resolveFirmwareWorkbench(request.projectDir)
  if (workbench) {
    await (runtime.runBuild ?? runFirmwareBuildProcess)(workbench.build)
    const artifactMetadata = await stat(workbench.artifactPath)
    if (!artifactMetadata.isFile()) {
      throw new Error("Firmware build did not create the configured artifact")
    }
  }
  const input = await loadFirmwareSimulationInput(request)
  const inspection = await (runtime.inspectHardware ?? inspectFirmwareHardware)(
    {
      circuitJson: request.circuitJson,
      input,
    },
  )
  if (inspection.hasErrors) {
    const shortDescriptions = inspection.shorts.map(
      (short) =>
        `Short on ${short.layer} at (${short.x_mm.toFixed(3)}mm, ${short.y_mm.toFixed(3)}mm): ${short.first_owner_labels.join(", ")} to ${short.second_owner_labels.join(", ")}`,
    )
    throw new Error(
      [
        "Firmware hardware inspection failed",
        ...inspection.issues,
        ...shortDescriptions,
      ].join("\n"),
    )
  }
  return (runtime.simulate ?? simulateWithDockerRenode)(input)
}
