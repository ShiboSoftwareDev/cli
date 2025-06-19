import { CircuitRunner } from "@tscircuit/eval/eval"
import { getVirtualFileSystemFromDirPath } from "make-vfs"
import path from "node:path"
import fs from "node:fs"
import Debug from "debug"

const debug = Debug("tsci:generate-circuit-json")

// Helper to get base output filename, removing .circuit.json if present
function getBaseOutputFileName(
  filePath: string,
  customOutputFileName?: string,
) {
  if (customOutputFileName) {
    return customOutputFileName.replace(/\.circuit\.json$/, "")
  }
  return path.basename(filePath).replace(/\.[^.]+$/, "")
}

const ALLOWED_FILE_EXTENSIONS = [
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".json",
  ".txt",
  ".md",
]

type GenerateCircuitJsonOptions = {
  filePath: string
  outputDir?: string
  outputFileName?: string
  saveToFile?: boolean
}

/**
 * Generates circuit JSON from a TSCircuit component file
 *
 * @param options Configuration options
 * @returns The generated circuit JSON object
 */
export async function generateCircuitJson({
  filePath, // Expecting an absolute path
  outputDir,
  outputFileName,
  saveToFile = false,
}: GenerateCircuitJsonOptions) {
  debug(`Generating circuit JSON for ${filePath}`)

  const runner = new CircuitRunner()
  const containingDir = path.dirname(filePath) // Absolute path to directory of filePath
  const componentFileName = path.basename(filePath) // Filename part, e.g., "index.tsx"

  const originalCwd = process.cwd()

  // Resolve outputDir against originalCwd BEFORE chdir.
  // If outputDir is not provided, it defaults to the filePath's directory (containingDir).
  const absoluteResolvedOutputDir = outputDir
    ? path.resolve(originalCwd, outputDir)
    : containingDir

  // Determine base name for output file (without .circuit.json extension)
  const baseOutputName = getBaseOutputFileName(filePath, outputFileName)
  const finalOutputPath = path.join(
    absoluteResolvedOutputDir,
    `${baseOutputName}.circuit.json`,
  )

  debug(
    `Effective VFS root (cwd for getVirtualFileSystemFromDirPath): ${containingDir}`,
  )
  debug(`Component file for VFS (mainComponentPath): ${componentFileName}`)
  debug(`Calculated final output path: ${finalOutputPath}`)

  let fsMapResult: Record<string, string>
  try {
    process.chdir(containingDir) // Change CWD to the directory of the file
    // Create a virtual file system with the project files, using "." as dirPath
    fsMapResult = (await getVirtualFileSystemFromDirPath({
      dirPath: ".", // Use "." for dirPath, relative to the new CWD (containingDir)
      fileMatchFn: (fp) => {
        // fp is relative to "." (which is containingDir)
        if (fp.includes("node_modules/")) return false
        if (fp.includes("dist/")) return false
        if (fp.includes("build/")) return false
        // Matches dotfiles/dotfolders at the current level e.g. ".git", "./.env"
        if (fp.match(/(?:^\.|^\.\/)\.?\w+/)) return false
        if (!ALLOWED_FILE_EXTENSIONS.includes(path.extname(fp))) return false
        return true
      },
      contentFormat: "string",
    })) as Record<string, string>
  } finally {
    process.chdir(originalCwd) // Change back CWD
  }

  const fsMap = { ...fsMapResult }

  // Execute the circuit runner with the virtual file system
  await runner.executeWithFsMap({
    fsMap, // Keys are relative to containingDir
    mainComponentPath: componentFileName, // Path relative to the root of fsMap (containingDir)
  })

  // Wait for the circuit to be fully rendered
  await runner.renderUntilSettled()

  // Get the circuit JSON
  const circuitJson = await runner.getCircuitJson()

  // Save the circuit JSON to a file if requested
  if (saveToFile) {
    debug(`Saving circuit JSON to ${finalOutputPath}`)
    // Ensure directory exists for finalOutputPath before writing
    fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true })
    fs.writeFileSync(finalOutputPath, JSON.stringify(circuitJson, null, 2))
  }

  return {
    circuitJson,
    outputPath: finalOutputPath, // Return the consistently calculated final output path
  }
}
