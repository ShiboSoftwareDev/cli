import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import getPort from "get-port"
import { FirmwareSimulationController } from "lib/server/firmware-simulation-controller"
import { handleFirmwareSimulationRequest } from "lib/server/handle-firmware-simulation-request"

const listenOnRandomPort = async (server: Server): Promise<string> => {
  const port = await getPort()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${port}/api`)
    })
  })
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })

test("uses handbook resource and verb routes for the firmware workbench", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "tsci-firmware-http-api-"))
  await writeFile(
    join(projectDir, "tscircuit.config.json"),
    JSON.stringify({
      firmwareSimulationEngine: "renode",
      firmwareSimulationConfigPath: "firmware-simulation.js",
    }),
  )
  await writeFile(
    join(projectDir, "firmware-simulation.js"),
    `export default ({ circuitJson }) => ({
      name: "http fixture",
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
        buttons: [{ componentName: "SW1" }],
        usb: { connectorComponentName: "USB1" }
      },
      steps: []
    })
    export const firmwareWorkbench = {
      sourcePath: "main.S",
      artifactPath: "firmware.bin",
      language: "arm-assembly",
      build: { command: "fake-build" }
    }`,
  )
  await writeFile(join(projectDir, "main.S"), "initial source")

  const controller = new FirmwareSimulationController(projectDir, {
    runBuild: async () => {
      await writeFile(join(projectDir, "firmware.bin"), "built firmware")
      return { stdout: "built", stderr: "" }
    },
    inspectHardware: async () => ({
      isComplete: true,
      hasErrors: false,
      displayStatus: "passed",
      issues: [],
      shorts: [],
    }),
  })
  const server = createServer((httpRequest, response) => {
    const requestUrl = new URL(
      httpRequest.url ?? "/",
      `http://${httpRequest.headers.host ?? "127.0.0.1"}`,
    )
    void handleFirmwareSimulationRequest({
      controller,
      httpRequest,
      response,
      url: requestUrl,
    })
  })
  const apiBaseUrl = await listenOnRandomPort(server)

  try {
    const preparedSimulation = await fetch(
      `${apiBaseUrl}/firmware_simulation/get`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit_json: [] }),
      },
    ).then((response) => response.json())
    expect(preparedSimulation.firmware_simulation.buttons).toEqual([
      { component_name: "SW1", is_pressed: false },
    ])
    expect(
      preparedSimulation.firmware_simulation.usb.connector_component_name,
    ).toBe("USB1")

    const sourceFromPost = await fetch(`${apiBaseUrl}/firmware_source/get`, {
      method: "POST",
    }).then((response) => response.json())
    expect(sourceFromPost.firmware_source.content).toBe("initial source")

    const sourceUpdate = await fetch(`${apiBaseUrl}/firmware_source/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_code: "updated source" }),
    })
    expect(sourceUpdate.status).toBe(200)

    const buildCreate = await fetch(`${apiBaseUrl}/firmware_build/create`, {
      method: "POST",
    }).then((response) => response.json())
    expect(buildCreate.firmware_simulation.firmware_project).toMatchObject({
      is_building: false,
      has_build_errors: false,
      display_status: "succeeded",
    })

    const usbUpdate = await fetch(`${apiBaseUrl}/firmware_usb/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_connected: true, circuit_json: [] }),
    }).then((response) => response.json())
    expect(usbUpdate.firmware_simulation).toMatchObject({
      is_in_bootloader: true,
      usb: {
        is_connected: true,
        is_powered: true,
        is_enumerated: true,
      },
      hardware_check: {
        is_complete: true,
        has_errors: false,
        display_status: "passed",
      },
    })

    const invalidMethod = await fetch(`${apiBaseUrl}/firmware_source/update`, {
      method: "GET",
    })
    expect(invalidMethod.status).toBe(405)
    expect(await invalidMethod.json()).toEqual({
      error: {
        error_code: "method_not_allowed",
        message: "Firmware simulation mutations require POST",
      },
    })
  } finally {
    await closeServer(server)
    await controller.delete()
  }
})
