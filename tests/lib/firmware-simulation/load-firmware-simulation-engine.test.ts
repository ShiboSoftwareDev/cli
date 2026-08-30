import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareFirmwareSimulationEngine } from "lib/firmware-simulation/load-firmware-simulation-engine"
import { projectConfigSchema } from "lib/project-config/project-config-schema"

test("only prepares the managed runtime for a project selecting Renode", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "tsci-lazy-renode-project-"))
  const cacheDirectory = await mkdtemp(
    join(tmpdir(), "tsci-lazy-renode-cache-"),
  )
  const previousCacheDirectory = process.env.TSCIRCUIT_RENODE_CACHE_DIR
  process.env.TSCIRCUIT_RENODE_CACHE_DIR = cacheDirectory
  try {
    await prepareFirmwareSimulationEngine(projectDir)
    expect(await readdir(cacheDirectory)).toEqual([])

    const installDirectory = join(
      cacheDirectory,
      `1.16.1-${process.platform}-${process.arch}`,
    )
    await mkdir(installDirectory, { recursive: true })
    const commandName = process.platform === "win32" ? "Renode.exe" : "renode"
    await Promise.all([
      writeFile(join(installDirectory, commandName), "fixture executable"),
      writeFile(
        join(installDirectory, "runtime.json"),
        JSON.stringify({
          version: "1.16.1",
          renodeCommand: commandName,
        }),
      ),
      writeFile(
        join(projectDir, "tscircuit.config.json"),
        JSON.stringify({ firmwareSimulationEngine: "renode" }),
      ),
    ])

    await expect(
      prepareFirmwareSimulationEngine(projectDir),
    ).resolves.toBeUndefined()
  } finally {
    if (previousCacheDirectory === undefined) {
      delete process.env.TSCIRCUIT_RENODE_CACHE_DIR
    } else {
      process.env.TSCIRCUIT_RENODE_CACHE_DIR = previousCacheDirectory
    }
  }
})

test("the project schema only accepts the supported firmware engine", () => {
  expect(
    projectConfigSchema.safeParse({ firmwareSimulationEngine: "renode" })
      .success,
  ).toBe(true)
  expect(
    projectConfigSchema.safeParse({ firmwareSimulationEngine: "docker" })
      .success,
  ).toBe(false)
})
