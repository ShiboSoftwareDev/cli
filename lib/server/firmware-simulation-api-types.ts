import type { FirmwareHardwareInspection } from "lib/firmware-simulation/inspect-firmware-hardware"

export type FirmwareDeviceMode = "off" | "sam_ba_bootloader" | "application"
export type FirmwareUsbDisplayStatus =
  | "disconnected"
  | "powered"
  | "hardware_fault"
  | "overcurrent_fault"
export type FirmwareBuildDisplayStatus =
  | "not_built"
  | "building"
  | "succeeded"
  | "failed"

export interface FirmwareProjectApiState {
  source_file_path: string
  artifact_file_path: string
  language: string
  is_building: boolean
  has_build_errors: boolean
  display_status: FirmwareBuildDisplayStatus
  build_output?: string
  has_build_artifact: boolean
  is_build_current: boolean
}

export interface FirmwareSourceApiState {
  file_path: string
  language: string
  content: string
}

export interface FirmwareSimulationApiState {
  is_configured: boolean
  is_running: boolean
  is_building: boolean
  is_programming: boolean
  is_in_bootloader: boolean
  has_error: boolean
  has_hardware_fault: boolean
  has_power_fault: boolean
  display_status:
    | "not_configured"
    | "stopped"
    | "building"
    | "programming"
    | "bootloader"
    | "ready"
    | "power_fault"
    | "hardware_fault"
    | "error"
  firmware_file_path?: string
  mcu_component_name?: string
  usb: {
    connector_component_name?: string
    is_connected: boolean
    is_powered: boolean
    is_enumerated: boolean
    has_hardware_fault: boolean
    has_overcurrent_fault: boolean
    display_status: FirmwareUsbDisplayStatus
  }
  hardware_check: {
    is_complete: boolean
    has_errors: boolean
    display_status: "unchecked" | "passed" | "failed"
    issues: string[]
    shorts: FirmwareHardwareInspection["shorts"]
  }
  reset_control?: {
    component_name: string
    bootloader_entry_method: "double_press"
    max_interval_ms: number
    presses_registered: 0 | 1
  }
  firmware_project?: FirmwareProjectApiState
  programming?: {
    method: "usb_sam_ba"
    bytes_written: number
    sha256: string
    is_verified: boolean
  }
  buttons: Array<{
    component_name: string
    is_pressed: boolean
  }>
  direct_switches: Array<{
    component_name: string
    led_component_name: string
    actuation: "momentary" | "latching"
    is_closed: boolean
  }>
  leds: Array<{
    component_name: string
    is_on: boolean
  }>
  error_message?: string
}
