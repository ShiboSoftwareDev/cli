import type {
  FirmwareSimulationInput,
  FirmwareSimulationSessionState,
} from "@tscircuit/renode-firmware-engine"
import type {
  FirmwareDeviceMode,
  FirmwareProjectApiState,
  FirmwareSimulationApiState,
  FirmwareUsbDisplayStatus,
} from "./firmware-simulation-api-types"
import type { FirmwareHardwareInspection } from "lib/firmware-simulation/inspect-firmware-hardware"

interface FirmwareSimulationApiStateRequest {
  isConfigured: boolean
  isBuilding: boolean
  isProgramming: boolean
  isUsbConnected: boolean
  isUsbPowered: boolean
  usbDisplayStatus: FirmwareUsbDisplayStatus
  deviceMode: FirmwareDeviceMode
  hardwareInspection?: FirmwareHardwareInspection
  resetPressRegistered: boolean
  input?: FirmwareSimulationInput
  physicalButtons?: FirmwareSimulationSessionState["buttons"]
  project?: FirmwareProjectApiState
  sessionState?: FirmwareSimulationSessionState
  errorMessage?: string
}

const getDisplayStatus = (
  request: FirmwareSimulationApiStateRequest,
): FirmwareSimulationApiState["display_status"] => {
  if (request.errorMessage) return "error"
  if (request.isBuilding) return "building"
  if (request.isProgramming) return "programming"
  if (
    request.isUsbConnected &&
    request.usbDisplayStatus === "overcurrent_fault"
  ) {
    return "power_fault"
  }
  if (request.isUsbConnected && request.usbDisplayStatus === "hardware_fault") {
    return "hardware_fault"
  }
  if (request.sessionState?.isRunning) return "ready"
  if (request.isUsbConnected && request.deviceMode === "sam_ba_bootloader") {
    return "bootloader"
  }
  return request.isConfigured ? "stopped" : "not_configured"
}

export const getFirmwareSimulationApiState = (
  request: FirmwareSimulationApiStateRequest,
): FirmwareSimulationApiState => {
  const isInBootloader = request.deviceMode === "sam_ba_bootloader"
  const hasHardwareFault = request.usbDisplayStatus === "hardware_fault"
  const hasPowerFault = request.usbDisplayStatus === "overcurrent_fault"
  const hardwareInspection = request.hardwareInspection
  const sessionState = request.sessionState
  const buttons =
    request.physicalButtons ??
    sessionState?.buttons ??
    request.input?.hardware.buttons.map((button) => ({
      componentName: button.componentName,
      isPressed: false,
    })) ??
    []
  const leds = request.input
    ? request.input.hardware.leds.map((led) => ({
        componentName: led.componentName,
        isOn:
          sessionState?.leds.find(
            (sessionLed) => sessionLed.componentName === led.componentName,
          )?.isOn ?? false,
      }))
    : (sessionState?.leds ?? [])

  return {
    is_configured: request.isConfigured,
    is_running: sessionState?.isRunning ?? false,
    is_building: request.isBuilding,
    is_programming: request.isProgramming,
    is_in_bootloader: isInBootloader,
    has_error: request.errorMessage !== undefined,
    has_hardware_fault: hasHardwareFault,
    has_power_fault: hasPowerFault,
    display_status: getDisplayStatus(request),
    usb: {
      ...(request.input?.hardware.usb?.connectorComponentName
        ? {
            connector_component_name:
              request.input.hardware.usb.connectorComponentName,
          }
        : {}),
      is_connected: request.isUsbConnected,
      is_powered: request.isUsbPowered,
      is_enumerated:
        request.isUsbPowered &&
        (isInBootloader || request.deviceMode === "application"),
      has_hardware_fault: hasHardwareFault,
      has_overcurrent_fault: hasPowerFault,
      display_status: request.usbDisplayStatus,
    },
    hardware_check: {
      is_complete: hardwareInspection?.isComplete ?? false,
      has_errors: hardwareInspection?.hasErrors ?? false,
      display_status: hardwareInspection?.displayStatus ?? "unchecked",
      issues: hardwareInspection?.issues ?? [],
      shorts: hardwareInspection?.shorts ?? [],
    },
    ...(request.input?.hardware.reset?.bootloaderEntry?.method ===
    "double_press"
      ? {
          reset_control: {
            component_name: request.input.hardware.reset.componentName,
            bootloader_entry_method: "double_press" as const,
            max_interval_ms:
              request.input.hardware.reset.bootloaderEntry
                .maxIntervalMilliseconds ?? 1_000,
            presses_registered: request.resetPressRegistered
              ? (1 as const)
              : (0 as const),
          },
        }
      : {}),
    ...(request.project ? { firmware_project: request.project } : {}),
    ...(request.input
      ? {
          firmware_file_path: request.input.firmware.path,
          mcu_component_name: request.input.hardware.mcu.componentName,
        }
      : {}),
    ...(sessionState
      ? {
          programming: {
            method: sessionState.programming.method,
            bytes_written: sessionState.programming.bytesWritten,
            sha256: sessionState.programming.sha256,
            is_verified: sessionState.programming.isVerified,
          },
        }
      : {}),
    buttons: buttons.map((button) => ({
      component_name: button.componentName,
      is_pressed: button.isPressed,
    })),
    leds: leds.map((led) => ({
      component_name: led.componentName,
      is_on: led.isOn,
    })),
    ...(request.errorMessage ? { error_message: request.errorMessage } : {}),
  }
}
