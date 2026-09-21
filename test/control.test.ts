import { describe, expect, it } from "vitest";
import { assembleRegisters, planAccumulatorLoop, fillerValue, valueForOp, type AccumulatorInstruction } from "../src/hell/index.js";
import { fixedWidthPolicy, UnshackledMachine } from "../src/malbolge/unshackled.js";
import { fromNumber } from "../src/malbolge/trits.js";
import { hasOracle20, ORACLE20, runOracleSource } from "./helpers.js";

describe("reusable accumulator control flow", () => {
  it.each([10, 20])("hands live memory values to a restoring loop at width %i", (width) => {
    const body: AccumulatorInstruction[] = [
      ...Array.from({ length: width }, (): AccumulatorInstruction => ({ op: "*", register: "value" })),
      { op: "<", register: "value" }, { op: "/", register: "value" },
    ];
    const loop = planAccumulatorLoop({ width, registers: { value: 0 }, body });
    const asm = assembleRegisters({ width, registers: { pointer: 0, value: 82 }, arrays: { data: [65] }, instructions: [
      { op: "array-base", dest: "pointer", array: "data" },
      { op: "store", pointer: "pointer", source: "value" }, { op: "set", dest: "value", value: 0 },
      { op: "load", dest: "value", pointer: "pointer" },
    ], runtime: { ...loop.runtime, bindings: [{ cell: loop.symbols.get("value")!, source: "value" }] } }, { maxSourceCells: 8_000_000 });
    const input = "\x01\x01\0";
    const m = UnshackledMachine.fromSource(asm.source, input, fixedWidthPolicy(width));
    expect(m.run(10_000_000), m.crashReason).toBe("halted");
    expect(m.outputString()).toBe("RRR");
    expect(m.read(fromNumber(loop.symbols.get("value")!))).toBe(fromNumber(82));
    // An odd number of active iterations still restores every operation and
    // steering cell. A jump back into ordinary straight-line code cannot pass.
    const patches = new Map(loop.runtime.patches.map((p) => [p.cell, p.value]));
    for (const cell of loop.activeCells) expect(m.read(fromNumber(cell))).toBe(fromNumber(Number(patches.get(cell))));
    if (width === 20 && hasOracle20) expect(runOracleSource(asm.source, ORACLE20, input)).toBe("RRR");
  }, 60_000);

  it("validates native operands and runtime installation targets", () => {
    expect(() => planAccumulatorLoop({ width: 10, registers: {}, body: [{ op: "*", register: "missing" }] })).toThrow(/unknown loop register/);
    expect(() => planAccumulatorLoop({ width: 10, registers: { "$loop.one": 0 }, body: [] })).toThrow(/reserved/);
    expect(() => assembleRegisters({ width: 10, registers: {}, instructions: [], runtime: {
      patches: [{ cell: 128, value: 0 }, { cell: 128, value: 1 }], entryPointer: 128,
    } })).toThrow(/duplicate runtime patch/);
    expect(() => assembleRegisters({ width: 10, registers: {}, instructions: [], runtime: {
      patches: [{ cell: 128, value: 0 }], entryPointer: 129,
    } })).toThrow(/entry pointer/);
    expect(() => assembleRegisters({ width: 10, registers: {}, instructions: [], runtime: {
      patches: [{ cell: 128, value: 0 }], entryPointer: 128, bindings: [{ cell: 129, source: "missing" }],
    } })).toThrow(/initialized cell/);
  });

  it("handles changing adjacent runtime bindings during return steering", () => {
    const asm = assembleRegisters({ width: 10, registers: { value: 12345 }, instructions: [], runtime: {
      patches: [{ cell: 500, value: 65 }, { cell: 501, value: 66 }, { cell: 504, value: 507 },
        { cell: 507, value: fillerValue(507) }, { cell: 508, value: valueForOp("v", 508) }],
      entryPointer: 504, bindings: [{ cell: 501, source: "value" }, { cell: 500, source: "value" }],
    } });
    const m = UnshackledMachine.fromSource(asm.source, "", fixedWidthPolicy(10));
    expect(m.run(1_000_000), m.crashReason).toBe("halted");
    expect(m.read(fromNumber(500))).toBe(fromNumber(12345));
    expect(m.read(fromNumber(501))).toBe(fromNumber(12345));
  });
});
