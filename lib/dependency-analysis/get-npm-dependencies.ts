import { getLocalFileDependencies } from "./getLocalFileDependencies"
import * as ts from "typescript"
import * as fs from "fs"
import path from "path"

function getDirectNpmDependencies(entryPoint: string): string[] {
  const allImportedFiles = Array.from(
    new Set([entryPoint, ...getLocalFileDependencies(entryPoint)]),
  )
  const npmDeps = new Set<string>()

  for (const file of allImportedFiles) {
    if (!fs.existsSync(file)) continue
    const content = fs.readFileSync(file, "utf-8")
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    )

    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const importPath = node.moduleSpecifier.text
        if (!importPath.startsWith(".")) {
          // It's a node module. Get the package name.
          const parts = importPath.split("/")
          const pkgName = parts[0].startsWith("@")
            ? `${parts[0]}/${parts[1]}`
            : parts[0]
          npmDeps.add(pkgName)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return Array.from(npmDeps)
}

function getTransitiveDependencies(
  packages: string[],
  projectDir: string,
): string[] {
  const queue = [...packages]
  const allDeps = new Set<string>(packages)
  const processed = new Set<string>()

  while (queue.length > 0) {
    const pkg = queue.shift()!
    if (processed.has(pkg)) continue
    processed.add(pkg)

    let pkgJsonPath: string
    try {
      pkgJsonPath = require.resolve(`${pkg}/package.json`, {
        paths: [projectDir],
      })
    } catch (e) {
      // console.warn(`Could not resolve package.json for ${pkg}`);
      continue
    }

    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
        if (pkgJson.dependencies) {
          for (const depName of Object.keys(pkgJson.dependencies)) {
            if (!allDeps.has(depName)) {
              allDeps.add(depName)
              queue.push(depName)
            }
          }
        }
      } catch (e) {
        // ignore malformed package.json
      }
    }
  }
  return Array.from(allDeps)
}

export function getNpmDependencies(entryPoint: string): string[] {
  const projectDir = path.dirname(entryPoint)
  const directDeps = getDirectNpmDependencies(entryPoint)
  return getTransitiveDependencies(directDeps, projectDir)
}
