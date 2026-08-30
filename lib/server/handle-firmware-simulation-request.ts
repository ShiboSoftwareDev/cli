import type { IncomingMessage, ServerResponse } from "node:http"
import type { CircuitJson } from "circuit-json"
import type { FirmwareSimulationController } from "./firmware-simulation-controller"

interface FirmwareRequestBody {
  circuit_json?: CircuitJson
  source_code?: string
  is_connected?: boolean
  button_component_name?: string
  is_pressed?: boolean
  switch_component_name?: string
  is_closed?: boolean
}

const writeJson = (request: {
  response: ServerResponse
  statusCode: number
  responseBody: object
}): void => {
  request.response.writeHead(request.statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  request.response.end(JSON.stringify(request.responseBody))
}

const readJsonBody = async (
  request: IncomingMessage,
): Promise<FirmwareRequestBody> => {
  const chunks: Buffer[] = []
  let byteCount = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteCount += buffer.length
    if (byteCount > 20 * 1024 * 1024) {
      throw new Error("Firmware simulation request exceeds 20 MB")
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const requestBody: FirmwareRequestBody = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  )
  if (!requestBody || typeof requestBody !== "object") {
    throw new Error("Firmware simulation request must be a JSON object")
  }
  return requestBody
}

const requireCircuitJson = (
  requestBody: FirmwareRequestBody,
  resourcePath: string,
): CircuitJson => {
  if (!Array.isArray(requestBody.circuit_json)) {
    throw new Error(`${resourcePath} requires circuit_json`)
  }
  return requestBody.circuit_json
}

const writeFirmwareSimulation = async (request: {
  response: ServerResponse
  firmwareSimulation: ReturnType<
    FirmwareSimulationController["getStateWithProject"]
  >
}): Promise<void> => {
  writeJson({
    response: request.response,
    statusCode: 200,
    responseBody: {
      firmware_simulation: await request.firmwareSimulation,
    },
  })
}

export const handleFirmwareSimulationRequest = async (request: {
  controller: FirmwareSimulationController
  httpRequest: IncomingMessage
  response: ServerResponse
  url: URL
}): Promise<void> => {
  const { controller, httpRequest, response, url } = request
  const pathParts = url.pathname.split("/").filter(Boolean)
  const resource = pathParts.at(-2)
  const verb = pathParts.at(-1)
  const method = httpRequest.method ?? ""

  try {
    if (
      resource === "firmware_simulation" &&
      verb === "get" &&
      (method === "GET" || method === "POST")
    ) {
      const requestBody =
        method === "POST" ? await readJsonBody(httpRequest) : undefined
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.refresh(
          Array.isArray(requestBody?.circuit_json)
            ? requestBody.circuit_json
            : undefined,
        ),
      })
      return
    }
    if (
      resource === "firmware_source" &&
      verb === "get" &&
      (method === "GET" || method === "POST")
    ) {
      writeJson({
        response,
        statusCode: 200,
        responseBody: { firmware_source: await controller.getSource() },
      })
      return
    }
    if (method !== "POST") {
      writeJson({
        response,
        statusCode: 405,
        responseBody: {
          error: {
            error_code: "method_not_allowed",
            message: "Firmware simulation mutations require POST",
          },
        },
      })
      return
    }

    const requestBody = await readJsonBody(httpRequest)
    if (resource === "firmware_source" && verb === "update") {
      if (typeof requestBody.source_code !== "string") {
        throw new Error("firmware_source/update requires source_code")
      }
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.saveSource(requestBody.source_code),
      })
      return
    }
    if (resource === "firmware_build" && verb === "create") {
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.build(),
      })
      return
    }
    if (resource === "firmware_usb" && verb === "update") {
      if (typeof requestBody.is_connected !== "boolean") {
        throw new Error("firmware_usb/update requires is_connected")
      }
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: requestBody.is_connected
          ? controller.connectUsb(
              requireCircuitJson(requestBody, "firmware_usb/update"),
            )
          : controller.disconnectUsb(),
      })
      return
    }
    if (resource === "firmware_reset" && verb === "create") {
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.pressReset(
          requireCircuitJson(requestBody, "firmware_reset/create"),
        ),
      })
      return
    }
    if (resource === "firmware_simulation" && verb === "create") {
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.create(
          requireCircuitJson(requestBody, "firmware_simulation/create"),
        ),
      })
      return
    }
    if (resource === "firmware_simulation" && verb === "update") {
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.update({
          ...(typeof requestBody.button_component_name === "string"
            ? { buttonComponentName: requestBody.button_component_name }
            : {}),
          ...(typeof requestBody.is_pressed === "boolean"
            ? { isPressed: requestBody.is_pressed }
            : {}),
          ...(typeof requestBody.switch_component_name === "string"
            ? { switchComponentName: requestBody.switch_component_name }
            : {}),
          ...(typeof requestBody.is_closed === "boolean"
            ? { isClosed: requestBody.is_closed }
            : {}),
        }),
      })
      return
    }
    if (resource === "firmware_simulation" && verb === "delete") {
      await writeFirmwareSimulation({
        response,
        firmwareSimulation: controller.delete(),
      })
      return
    }
    writeJson({
      response,
      statusCode: 404,
      responseBody: {
        error: {
          error_code: "firmware_simulation_route_not_found",
          message: "Unknown firmware simulation route",
        },
      },
    })
  } catch (error) {
    writeJson({
      response,
      statusCode: 400,
      responseBody: {
        error: {
          error_code: "firmware_simulation_failed",
          message:
            error instanceof Error
              ? error.message
              : "Firmware simulation failed",
        },
      },
    })
  }
}
