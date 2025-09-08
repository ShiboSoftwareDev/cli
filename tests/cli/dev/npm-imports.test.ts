import { afterAll, expect, test } from "bun:test"
import { DevServer } from "cli/dev/DevServer"
import getPort from "get-port"
import { join } from "node:path"
import { getCliTestFixture } from "../../fixtures/get-cli-test-fixture"
import { execSync } from "child_process"
import fs from "fs"

let devServer: DevServer

test("npm imports in dev server", async () => {
  const fixture = await getCliTestFixture()

  // Install a dependency
  execSync("bun add is-odd", { cwd: fixture.tmpDir })

  // Create test circuit file that uses the dependency
  const circuitPath = join(fixture.tmpDir, "index.tsx")
  fs.writeFileSync(
    circuitPath,
    `
    import isOdd from 'is-odd';
    console.log("is 3 odd?", isOdd(3));
    export const MyCircuit = () => (
      <board width="10mm" height="10mm" />
    )
    `,
  )

  fs.writeFileSync(
    join(fixture.tmpDir, "package.json"),
    JSON.stringify({
      name: "test-project",
      dependencies: { "is-odd": "latest" },
    }),
  )

  const devServerPort = await getPort()

  devServer = new DevServer({
    port: devServerPort,
    componentFilePath: circuitPath,
    projectDir: fixture.tmpDir,
  })

  await devServer.start()

  const { file_list } = await devServer.fsKy.get("api/files/list").json()

  const filePaths = file_list.map((f: any) => f.file_path)

  expect(filePaths).toContain("node_modules/is-odd/index.js")
  expect(filePaths).toContain("node_modules/is-number/index.js") // is-odd depends on is-number

  const isOddFileContent = await devServer.fsKy
    .get("api/files/get", {
      searchParams: {
        file_path: "node_modules/is-odd/index.js",
      },
    })
    .json()
  expect(isOddFileContent.file.text_content).toContain("is-number")
}, 30000)

afterAll(async () => {
  await devServer?.stop()
})
