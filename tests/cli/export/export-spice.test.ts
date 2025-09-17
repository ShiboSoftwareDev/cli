import { getCliTestFixture } from "../../fixtures/get-cli-test-fixture"
import { test, expect } from "bun:test"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"

const circuitCode = `export default () => (
  <board width={30} height={30}>
    <voltagesource
      name="V1"
      voltage={"5V"}
      schY={2}
      schX={-5}
      schRotation={270}
    />
    <trace from={".V1 > .pin1"} to={".L1 > .pin1"} />
    <trace from={".L1 > .pin2"} to={".D1 > .anode"} />
    <trace from={".D1 > .cathode"} to={".C1 > .pin1"} />
    <trace from={".D1 > .cathode"} to={".R1 > .pin1"} />
    <trace from={".C1 > .pin2"} to={".R1 > .pin2"} />
    <trace from={".R1 > .pin2"} to={".V1 > .pin2"} />
    <trace from={".L1 > .pin2"} to={".M1 > .drain"} />
    <trace from={".M1 > .source"} to={".V1 > .pin2"} />
    <trace from={".M1 > .source"} to={"net.GND"} />
    <trace from={".M1 > .gate"} to={".V2 > .pin1"} />
    <trace from={".V2 > .pin2"} to={".V1 > .pin2"} />
    <inductor name="L1" inductance={"1H"} footprint={"0603"} schY={3} pcbY={6} pcbX={-3} />
    <diode name="D1" footprint={"0603"} schY={3} schX={3} pcbY={6} pcbX={3} />
    <capacitor
      polarized
      schRotation={270}
      name="C1"
      capacitance={"10uF"}
      footprint={"0603"}
      schX={3}
      pcbX={3}
    />
    <resistor
      schRotation={270}
      name="R1"
      resistance={"1k"}
      footprint={"0603"}
      schX={6}
      pcbX={9}
    />
    <voltagesource
      name="V2"
      schRotation={270}
      voltage={"10V"}
      waveShape="square"
      dutyCycle={0.68}
      frequency={"1kHz"}
      schX={-3}
    />
    <mosfet
      channelType="n"
      footprint={"sot23"}
      name="M1"
      mosfetMode="enhancement"
      pcbX={-4}
    />
  </board>
)`

test(
  "export spice",
  async () => {
    const { tmpDir, runCommand } = await getCliTestFixture()
    const circuitPath = path.join(tmpDir, "test-circuit.tsx")

    await writeFile(circuitPath, circuitCode)

    const { stdout, stderr } = await runCommand(
      `tsci export ${circuitPath} -f spice`,
    )

    const expectedSpicePath = path.join(tmpDir, "test-circuit.spice.cir")
    const expectedCsvPath = path.join(tmpDir, "test-circuit.csv")

    expect(stdout).toContain(
      `Exported to ${expectedSpicePath} and ${expectedCsvPath} (simulation results)!`,
    )

    const spiceContent = await readFile(expectedSpicePath, "utf-8")
    expect(spiceContent).toContain("* Circuit JSON to SPICE Netlist")
    expect(spiceContent).toContain(".tran")
    expect(spiceContent).toContain("Vsimulation_voltage_source_0")
    expect(spiceContent).toContain("LL1")
    expect(spiceContent).toContain("DD1")
    expect(spiceContent).toContain("CC1")
    expect(spiceContent).toContain("RR1")
    expect(spiceContent).toContain("SM1")
    expect(spiceContent).toContain(".END")

    const csvContent = await readFile(expectedCsvPath, "utf-8")

    expect(csvContent).toContain("time,")
    expect(csvContent).toContain("v(n")
    const csvLines = csvContent.trim().split("\n")
    expect(csvLines.length).toBeGreaterThan(10)
    const headerColumns = csvLines[0].split(",")
    const firstDataLine = csvLines[1]
    expect(firstDataLine.split(",").length).toBe(headerColumns.length)
  },
  { timeout: 30000 },
)
