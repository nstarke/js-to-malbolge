import { describe, expect, it } from "vitest";
import { assembleRegisters, fixedWord } from "../src/hell/init.js";
import { StandardMachine } from "../src/malbolge/standard.js";
import { fixedWidthPolicy, UnshackledMachine } from "../src/malbolge/unshackled.js";
import { crazy, fromNumber, tritAt } from "../src/malbolge/trits.js";
import { hasOracle20, ORACLE20, runOracleSource } from "./helpers.js";

describe("fixed-width initialization", () => {
  it.each([10, 20])("builds wide constants, repeating masks, and a wide data word at width %i", (width) => {
    const values = { zero: 0, one: 1, two: 2, edge: 81, max: -1, high: 3n ** BigInt(width - 1), mask0: "01", mask2: "21" };
    const asm = assembleRegisters({ width, registers: values, initialize: [{ cell: 50000, value: 12345 }], instructions: [] });
    const m = UnshackledMachine.fromSource(asm.source, "", fixedWidthPolicy(width));
    expect(m.run(1_000_000), m.crashReason).toBe("halted");
    for (const [name, value] of Object.entries(values)) {
      expect(m.read(fromNumber(asm.symbols.get(name)!)), name).toBe(fixedWord(value, width));
    }
    expect(m.read(fromNumber(50000))).toBe(fromNumber(12345));
    expect(asm.codeEnd).toBeLessThan(50000);
    if (width === 10) {
      const std = StandardMachine.fromSource(asm.source);
      expect(std.run(1_000_000)).toBe("halted");
      for (const [name, value] of Object.entries(values)) {
        const word = fixedWord(value, width);
        let finite = 0;
        for (let i = width - 1; i >= 0; i--) finite = finite * 3 + tritAt(word, i);
        expect(std.mem[asm.symbols.get(name)!], name).toBe(finite);
      }
      expect(std.mem[50000]).toBe(12345);
    }
  });

  it.skipIf(!hasOracle20)("builds a wide value without input on the fixed-width C oracle", () => {
    const asm = assembleRegisters({ width: 20, registers: { value: 65n * 3n ** 12n },
      instructions: [{ op: "rotate", dest: "value", count: 12 }, { op: "putc", source: "value" }] });
    expect(runOracleSource(asm.source, ORACLE20)).toBe("A");
  });

  it("preserves runtime values on copies and handles crazy operand aliases", () => {
    const asm = assembleRegisters({ width: 10, registers: { a: 66, b: 81, saved: 0, changed: 0 }, instructions: [
      { op: "copy", dest: "saved", source: "a" }, { op: "copy", dest: "a", source: "a" },
      { op: "crazy", dest: "a", a: "a", b: "b" },
      { op: "copy", dest: "changed", source: "a" },
      { op: "copy", dest: "a", source: "saved" },
      { op: "putc", source: "a" }, { op: "set", dest: "a", value: 67 }, { op: "putc", source: "a" },
    ] });
    const m = UnshackledMachine.fromSource(asm.source, "", fixedWidthPolicy(10));
    expect(m.run(1_000_000)).toBe("halted");
    expect(m.outputString()).toBe("BC");
    expect(m.read(fromNumber(asm.symbols.get("saved")!))).toBe(fromNumber(66));
    expect(m.read(fromNumber(asm.symbols.get("b")!))).toBe(fromNumber(81));
    expect(m.read(fromNumber(asm.symbols.get("changed")!))).toBe(crazy(fromNumber(66), fromNumber(81)));
  });

  it("rejects invalid widths, base-2 masks, aliases with code and unknown registers", () => {
    for (const width of [9, 10.5, 21]) expect(() => fixedWord(0, width)).toThrow(/width/);
    for (const value of ["2", "bad", "0000000000010"]) expect(() => fixedWord(value, 10)).toThrow();
    expect(() => fixedWord(NaN, 10)).toThrow(/integer/);
    expect(() => assembleRegisters({ width: 10, registers: {}, initialize: [{ cell: 127, value: 1 }], instructions: [] })).toThrow(/overlaps code/);
    expect(() => assembleRegisters({ width: 10, registers: {}, initialize: [{ cell: 50000, value: 1 }, { cell: 50000, value: 2 }], instructions: [] })).toThrow(/duplicate/);
    expect(() => assembleRegisters({ width: 10, registers: {}, instructions: [{ op: "copy", dest: "missing", source: "missing" }] })).toThrow(/unknown register/);
    expect(() => assembleRegisters({ width: 10, registers: Object.fromEntries(Array.from({ length: 23 }, (_, n) => [`r${n}`, 0])), instructions: [] })).toThrow(/at most 22/);
    expect(() => assembleRegisters({ width: 20, registers: { wide: -1 }, instructions: [] }, { maxSourceCells: 1000 })).toThrow(/source cell budget/);
    expect(() => assembleRegisters({ width: 20, registers: {}, initialize: [{ cell: 10000000, value: 1 }], instructions: [] })).toThrow(/source cell budget/);
  });
});
