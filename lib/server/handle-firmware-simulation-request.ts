import type { IncomingMessage, ServerResponse } from "node:http"
import type { CircuitJson } from "circuit-json"
import type { FirmwareSimulationController } from "./firmware-simulation-controller"

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  responseBody: object,
): void => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  response.end(JSON.stringify(responseBody))
}

const readJsonBody = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
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
  const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!requestBody || typeof requestBody !== "object") {
    throw new Error("Firmware simulation request must be a JSON object")
  }
  return requestBody as Record<string, unknown>
}

export const handleFirmwareSimulationRequest = async (request: {
  controller: FirmwareSimulationController
  httpRequest: IncomingMessage
  response: ServerResponse
  url: URL
}): Promise<void> => {
  const { controller, httpRequest, response, url } = request
  const verb = url.pathname.split("/").at(-1)
  try {
    if (verb === "get" && ["GET", "POST"].includes(httpRequest.method ?? "")) {
      writeJson(response, 200, {
        firmware_simulation: await controller.refresh(),
      })
      return
    }
    if (verb === "get_source" && httpRequest.method === "GET") {
      writeJson(response, 200, {
        firmware_source: await controller.getSource(),
      })
      return
    }
    if (httpRequest.method !== "POST") {
      writeJson(response, 405, {
        error: {
          error_code: "method_not_allowed",
          message: "Firmware simulation mutations require POST",
        },
      })
      return
    }
    const requestBody = await readJsonBody(httpRequest)
    if (verb === "save_source") {
      if (typeof requestBody.source_code !== "string") {
        throw new Error("firmware_simulation/save_source requires source_code")
      }
      writeJson(response, 200, {
        firmware_simulation: await controller.saveSource(
          requestBody.source_code,
        ),
      })
      return
    }
    if (verb === "build") {
      writeJson(response, 200, {
        firmware_simulation: await controller.build(),
      })
      return
    }
    if (verb === "connect_usb") {
      if (!Array.isArray(requestBody.circuit_json)) {
        throw new Error("firmware_simulation/connect_usb requires circuit_json")
      }
      writeJson(response, 200, {
        firmware_simulation: await controller.connectUsb(
          requestBody.circuit_json as CircuitJson,
        ),
      })
      return
    }
    if (verb === "disconnect_usb") {
      writeJson(response, 200, {
        firmware_simulation: await controller.disconnectUsb(),
      })
      return
    }
    if (verb === "press_reset") {
      if (!Array.isArray(requestBody.circuit_json)) {
        throw new Error("firmware_simulation/press_reset requires circuit_json")
      }
      writeJson(response, 200, {
        firmware_simulation: await controller.pressReset(
          requestBody.circuit_json as CircuitJson,
        ),
      })
      return
    }
    if (verb === "program" || verb === "create") {
      if (!Array.isArray(requestBody.circuit_json)) {
        throw new Error("firmware_simulation/program requires circuit_json")
      }
      writeJson(response, 200, {
        firmware_simulation: await controller.program(
          requestBody.circuit_json as CircuitJson,
        ),
      })
      return
    }
    if (verb === "update") {
      writeJson(response, 200, {
        firmware_simulation: await controller.update({
          ...(typeof requestBody.button_component_name === "string"
            ? { buttonComponentName: requestBody.button_component_name }
            : {}),
          ...(typeof requestBody.is_pressed === "boolean"
            ? { isPressed: requestBody.is_pressed }
            : {}),
        }),
      })
      return
    }
    if (verb === "delete") {
      writeJson(response, 200, {
        firmware_simulation: await controller.delete(),
      })
      return
    }
    writeJson(response, 404, {
      error: {
        error_code: "firmware_simulation_route_not_found",
        message: "Unknown firmware simulation route",
      },
    })
  } catch (error) {
    writeJson(response, 400, {
      error: {
        error_code: "firmware_simulation_failed",
        message:
          error instanceof Error ? error.message : "Firmware simulation failed",
      },
    })
  }
}
