import { describe, expect, it } from "vitest";
import { Arithmetic, assembleRegisters, fixedWord } from "../src/hell/index.js";
import { fixedWidthPolicy, UnshackledMachine } from "../src/malbolge/unshackled.js";
import { fromNumber } from "../src/malbolge/trits.js";
import { hasOracle20, ORACLE20, runOracleSource } from "./helpers.js";

describe("indexed register memory", () => {
  it.each([10, 20])("loads and overwrites runtime-selected frames at width %i", (width) => {
    const ar = new Arithmetic(width);
    const asm = assembleRegisters({ width, registers: { ...ar.registers, index: 0, pointer: 0, value: 82, result: 0 },
      arrays: { data: [65, 66, 67], neighbor: [3n ** BigInt(width - 1)] }, instructions: [
        { op: "getc", dest: "index" }, ...ar.address("pointer", "data", "index"),
        { op: "load", dest: "result", pointer: "pointer" }, { op: "putc", source: "result" },
        { op: "store", pointer: "pointer", source: "value" },
        { op: "load", dest: "result", pointer: "pointer" }, { op: "putc", source: "result" },
      ] });
    for (const index of [0, 1, 2]) {
      const input = String.fromCharCode(index);
      const m = UnshackledMachine.fromSource(asm.source, input, fixedWidthPolicy(width));
      expect(m.run(1_000_000), m.crashReason).toBe("halted");
      expect(m.outputString()).toBe(String.fromCharCode(65 + index) + "R");
      const array = asm.arrays.get("data")!;
      for (let i = 0; i < array.length; i++) {
        const cell = array.base + i * array.stride;
        expect(m.read(fromNumber(cell))).toBe(fromNumber(i === index ? 82 : 65 + i));
        expect(m.read(fromNumber(cell + 1))).toBe(fromNumber(cell - 1));
        expect(m.read(fromNumber(cell + 2))).toBe(fromNumber(38));
      }
      expect(m.read(fromNumber(asm.arrays.get("neighbor")!.base))).toBe(fixedWord(3n ** BigInt(width - 1), width));
      expect(m.read(fromNumber(asm.symbols.get("index")!))).toBe(fromNumber(index));
      if (width === 20 && hasOracle20) expect(runOracleSource(asm.source, ORACLE20, input)).toBe(m.outputString());
    }
  });

  it.each([10, 20])("supports pointer/output aliases and repeated wide stores at width %i", (width) => {
    const wide = 3n ** BigInt(width) - 1n;
    const asm = assembleRegisters({ width, registers: { pointer: 0, value: wide, result: 0 }, arrays: { data: [0] }, instructions: [
      { op: "array-base", dest: "pointer", array: "data" },
      { op: "store", pointer: "pointer", source: "value" },
      { op: "load", dest: "result", pointer: "pointer" },
      { op: "store", pointer: "pointer", source: "pointer" },
      { op: "load", dest: "pointer", pointer: "pointer" },
      { op: "set", dest: "value", value: 0 }, { op: "store", pointer: "pointer", source: "value" },
    ] });
    const m = UnshackledMachine.fromSource(asm.source, "", fixedWidthPolicy(width));
    expect(m.run(1_000_000), m.crashReason).toBe("halted");
    expect(m.read(fromNumber(asm.symbols.get("result")!))).toBe(fixedWord(wide, width));
    expect(m.read(fromNumber(asm.symbols.get("pointer")!))).toBe(fromNumber(asm.arrays.get("data")!.base - 1));
    expect(m.read(fromNumber(asm.arrays.get("data")!.base))).toBe("0");
  });

  it("rejects missing and empty arrays", () => {
    expect(() => assembleRegisters({ width: 10, registers: {}, arrays: { empty: [] }, instructions: [] })).toThrow(/empty/);
    expect(() => assembleRegisters({ width: 10, registers: { p: 0 }, instructions: [
      { op: "array-base", dest: "p", array: "missing" },
    ] })).toThrow(/unknown array/);
  });
});
