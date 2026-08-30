import type { Command } from "commander"
import { runFirmwareSimulationCommand } from "./run-firmware-simulation-command"

export const registerFirmwareSimulation = (simulateCommand: Command): void => {
  simulateCommand
    .command("firmware")
    .description("Program and test firmware in Renode")
    .argument("<file>", "Path to tscircuit tsx or circuit json file")
    .option("--disable-parts-engine", "Disable the parts engine")
    .action((file: string, options: { disablePartsEngine?: boolean }) =>
      runFirmwareSimulationCommand({ file, options }),
    )
}
