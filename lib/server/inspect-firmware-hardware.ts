import { findBitmapShorts, type BitmapShort } from "@tscircuit/check-shorts"
import {
  FirmwareHardwareContractError,
  type FirmwareSimulationInput,
  validateHardwareContract,
} from "@tscircuit/renode-firmware-engine"
import type { CircuitJson, LayerRef } from "circuit-json"
import { getCheckShortLayers } from "../../cli/check/shorts/get-check-short-layers"

export interface FirmwareHardwareShort {
  layer: LayerRef
  x_mm: number
  y_mm: number
  first_owner_labels: string[]
  second_owner_labels: string[]
  pixel_count: number
}

export interface FirmwareHardwareInspection {
  status: "passed" | "failed"
  issues: string[]
  shorts: FirmwareHardwareShort[]
}

type FindShorts = (
  circuitJson: CircuitJson,
  options: { mode: "gerber"; layer: LayerRef },
) => Promise<BitmapShort[]>

const toApiShort = (short: BitmapShort): FirmwareHardwareShort => ({
  layer: short.layer,
  x_mm: short.center.x,
  y_mm: short.center.y,
  first_owner_labels: short.firstOwnerLabels,
  second_owner_labels: short.secondOwnerLabels,
  pixel_count: short.pixelCount,
})

export const inspectFirmwareHardware = async (request: {
  circuitJson: CircuitJson
  input: FirmwareSimulationInput
  findShorts?: FindShorts
}): Promise<FirmwareHardwareInspection> => {
  const issues: string[] = []
  try {
    validateHardwareContract(request.circuitJson, request.input.hardware)
  } catch (error) {
    if (error instanceof FirmwareHardwareContractError) {
      issues.push(...error.issues)
    } else {
      issues.push(
        error instanceof Error
          ? error.message
          : "Firmware hardware validation failed",
      )
    }
  }

  const findShorts = request.findShorts ?? findBitmapShorts
  const layers = getCheckShortLayers({
    circuitJson: request.circuitJson,
    layerOption: "all",
  })
  const shorts = (
    await Promise.all(
      layers.map((layer) =>
        findShorts(request.circuitJson, { mode: "gerber", layer }),
      ),
    )
  )
    .flat()
    .map(toApiShort)

  return {
    status: issues.length === 0 && shorts.length === 0 ? "passed" : "failed",
    issues,
    shorts,
  }
}
