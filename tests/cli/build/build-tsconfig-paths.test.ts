import { expect, test } from "bun:test"
import { getCliTestFixture } from "../../fixtures/get-cli-test-fixture"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"

test("build resolves tsconfig paths aliases", async () => {
  const { tmpDir, runCommand } = await getCliTestFixture()
  await mkdir(path.join(tmpDir, "some-folder", "src"), { recursive: true })
  await mkdir(path.join(tmpDir, "src", "utils"), { recursive: true })

  await writeFile(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@some-folder/*": ["./some-folder/*"],
          "@src/*": ["./src/*"],
          "@utils/*": ["./src/utils/*"],
        },
      },
    }),
  )

  await writeFile(
    path.join(tmpDir, "some-folder", "src", "file.tsx"),
    `
      export const something = 123
    `,
  )

  await writeFile(
    path.join(tmpDir, "src", "utils", "values.ts"),
    `
      export const resistorName = "Rpaths"
      export const resistance = "1k"
    `,
  )

  await writeFile(
    path.join(tmpDir, "src", "component.tsx"),
    `
      import { resistorName, resistance } from "@utils/values"
      export default () => (<resistor name={resistorName} footprint={"0603"} resistance={resistance} />)
    `,
  )

  await writeFile(
    path.join(tmpDir, "user.tsx"),
    `
      import { something } from "@some-folder/src/file"
      something;
      import Comp from "@src/component"
      export default () => (<Comp />)
    `,
  )

  await writeFile(path.join(tmpDir, "package.json"), "{}")

  const { stderr } = await runCommand("tsci build user.tsx")
  expect(stderr).toBe("")

  const data = await readFile(
    path.join(tmpDir, "dist", "user", "circuit.json"),
    "utf-8",
  )
  const json = JSON.parse(data)
  const resistor = json.find(
    (el: any) => el.type === "source_component" && el.name === "Rpaths",
  )
  expect(resistor).toBeDefined()
  expect(resistor.resistance).toBe(1000)
}, 30_000)
