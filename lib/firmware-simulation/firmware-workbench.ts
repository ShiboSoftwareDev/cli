import { spawn } from "node:child_process"
import path from "node:path"
import { loadFirmwareSimulationConfig } from "./load-firmware-simulation-config"

export interface ResolvedFirmwareWorkbench {
  sourcePath: string
  artifactPath: string
  language: string
  build: {
    command: string
    args: string[]
    workingDirectory: string
    timeoutMilliseconds: number
  }
}

export type RunFirmwareBuild = (request: {
  command: string
  args: string[]
  workingDirectory: string
  timeoutMilliseconds: number
}) => Promise<{ stdout: string; stderr: string }>

const isPathInsideOrEqual = (request: {
  candidatePath: string
  projectDir: string
}): boolean => {
  const relativePath = path.relative(request.projectDir, request.candidatePath)
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  )
}

const appendBuildOutput = (request: {
  currentOutput: string
  chunk: Buffer
}): string =>
  `${request.currentOutput}${request.chunk.toString("utf8")}`.slice(-64 * 1024)

export const runFirmwareBuildProcess: RunFirmwareBuild = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.workingDirectory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBuildOutput({ currentOutput: stdout, chunk })
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBuildOutput({ currentOutput: stderr, chunk })
    })
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(
        new Error(
          `Firmware build timed out after ${request.timeoutMilliseconds}ms`,
        ),
      )
    }, request.timeoutMilliseconds)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (exitCode) => {
      clearTimeout(timeout)
      if (exitCode === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `Firmware build exited with ${exitCode ?? "no status"}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
        ),
      )
    })
  })

export const resolveFirmwareWorkbench = async (
  projectDir: string,
): Promise<ResolvedFirmwareWorkbench | undefined> => {
  const config = await loadFirmwareSimulationConfig(projectDir)
  const workbench = config.firmwareWorkbench
  if (!workbench) return undefined
  const configDirectory = path.dirname(config.configPath)
  const sourcePath = path.resolve(configDirectory, workbench.sourcePath)
  const artifactPath = path.resolve(configDirectory, workbench.artifactPath)
  const workingDirectory = path.resolve(
    configDirectory,
    workbench.build.workingDirectory ?? ".",
  )
  for (const [description, candidatePath] of [
    ["Firmware source", sourcePath],
    ["Firmware artifact", artifactPath],
    ["Firmware build working directory", workingDirectory],
  ] as const) {
    if (!isPathInsideOrEqual({ candidatePath, projectDir })) {
      throw new Error(
        `${description} must resolve inside the project directory`,
      )
    }
  }
  if (!workbench.build.command.trim()) {
    throw new Error("Firmware build command is required")
  }
  return {
    sourcePath,
    artifactPath,
    language: workbench.language ?? "text",
    build: {
      command: workbench.build.command,
      args: workbench.build.args ?? [],
      workingDirectory,
      timeoutMilliseconds: workbench.build.timeoutMilliseconds ?? 30_000,
    },
  }
}
