import { describe, expect, it } from "vitest";
import { Arithmetic } from "../src/hell/arithmetic.js";
import { assembleRegisterLoop, planRegisterLoop } from "../src/hell/register-loop.js";
import { fixedWord } from "../src/hell/init.js";
import { fillerValue, valueForOp } from "../src/hell/cycles.js";
import { UnshackledMachine, fixedWidthPolicy } from "../src/malbolge/unshackled.js";
import { fromNumber } from "../src/malbolge/trits.js";
import { hasOracle20, ORACLE20, runOracleSource } from "./helpers.js";

describe("register instructions in reusable control flow", () => {
  it("installs arithmetic and load/store in a loop from legal source", () => {
    const width = 20, ar = new Arithmetic(width);
    const asm = assembleRegisterLoop({ width, registers: { ...ar.registers, pointer: 0, value: 0, digit: 0, again: 0 }, arrays: { data: [0] }, body: [
      { op: "array-base", dest: "pointer", array: "data" }, { op: "getc", dest: "value" },
      { op: "store", pointer: "pointer", source: "value" }, { op: "set", dest: "value", value: 0 },
      { op: "load", dest: "value", pointer: "pointer" }, ...ar.trit("digit", "value", 0),
      { op: "putc", source: "digit" }, { op: "getc", dest: "again" },
    ], while: "again" }, { maxSourceCells: 15_000_000 });
    const input = "A\x01B\x01C\0", expected = "\x02\0\x01";
    const m = UnshackledMachine.fromSource(asm.source, input, fixedWidthPolicy(width));
    expect(m.run(20_000_000), m.crashReason).toBe("halted");
    expect(m.outputString()).toBe(expected);
    expect(m.read(fromNumber(asm.loop.arrays.get("data")!.cells[0]))).toBe(fromNumber(67));
    if (hasOracle20) expect(runOracleSource(asm.source, ORACLE20, input)).toBe(expected);
  }, 30_000);

  it("reuses full-width increment and dynamic indexed addressing across iterations", () => {
    const width = 20, ar = new Arithmetic(width), max = 3n ** 20n - 1n;
    const loop = planRegisterLoop({ width, registers: { ...ar.registers, index: 0, pointer: 0, value: 0, again: 0 }, arrays: { data: [max, 80] }, body: [
      { op: "getc", dest: "index" }, ...ar.address("pointer", "data", "index"),
      { op: "load", dest: "value", pointer: "pointer" }, ...ar.increment("value"),
      { op: "store", pointer: "pointer", source: "value" }, { op: "putc", source: "value" }, { op: "getc", dest: "again" },
    ], while: "again" });
    // Isolate the large compiled runtime here; the source installation path is
    // covered above, and the full increment/store/load source is an external
    // integration probe documented with its measured size.
    const m = UnshackledMachine.fromSource(String.fromCharCode(valueForOp("v", 0), fillerValue(1)), "\0\x01\x01\x01\0\0", fixedWidthPolicy(width));
    for (const p of loop.runtime.patches) m.write(fromNumber(p.cell), fixedWord(p.value, width));
    m.c = fromNumber(loop.entry + 1); m.d = fromNumber(loop.runtime.entryPointer + 1);
    expect(m.run(30_000_000), m.crashReason).toBe("halted");
    expect(m.outputString()).toBe("\0Q\x01");
    const cells = loop.arrays.get("data")!.cells;
    expect(m.read(fromNumber(cells[0]))).toBe(fromNumber(1));
    expect(m.read(fromNumber(cells[1]))).toBe(fromNumber(81));
    expect(m.read(fromNumber(loop.symbols.get("value")!))).toBe(fromNumber(1));
  }, 60_000);

  it("supports aliased pointers and repeated wide stores", () => {
    const width = 20, max = 3n ** 20n - 1n;
    const asm = assembleRegisterLoop({ width, registers: { pointer: 0, value: max, again: 0 }, arrays: { data: [0] }, body: [
      { op: "array-base", dest: "pointer", array: "data" }, { op: "store", pointer: "pointer", source: "pointer" },
      { op: "load", dest: "pointer", pointer: "pointer" }, { op: "store", pointer: "pointer", source: "value" },
      { op: "load", dest: "value", pointer: "pointer" }, { op: "getc", dest: "again" },
    ], while: "again" }, { maxSourceCells: 15_000_000 });
    const m = UnshackledMachine.fromSource(asm.source, "\x01\0", fixedWidthPolicy(width));
    expect(m.run(20_000_000), m.crashReason).toBe("halted");
    expect(m.read(fromNumber(asm.loop.arrays.get("data")!.cells[0]))).toBe(fixedWord(max, width));
  }, 30_000);

  it("rejects invalid contracts before installation", () => {
    expect(() => planRegisterLoop({ width: 20, registers: {}, body: [], while: "missing" })).toThrow(/unknown register/);
    expect(() => planRegisterLoop({ width: 20, registers: { flag: 0 }, body: [{ op: "require-width", width: 10 }], while: "flag" })).toThrow(/width/);
    expect(() => planRegisterLoop({ width: 20, registers: { flag: 0 }, body: [{ op: "array-base", dest: "flag", array: "missing" }], while: "flag" })).toThrow(/unknown array/);
  });
});
