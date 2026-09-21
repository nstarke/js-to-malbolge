import { describe, expect, it } from "vitest";
import { assemble, visit, loadConstant, ref, type CodeBlock, type Visit } from "../src/hell/index.js";
import { StandardMachine } from "../src/malbolge/standard.js";
import { UnshackledMachine, fixedWidthPolicy } from "../src/malbolge/unshackled.js";
import { crazy, fromNumber } from "../src/malbolge/trits.js";
import { hasOracle, hasOracle20, ORACLE, ORACLE20, runOracleSource } from "./helpers.js";

const p: CodeBlock = { label: "P", op: "p", address: 81 };

const values = [0, 1, 2, 8, 9, 26, 27, 53, 54, 79, 80];
let assembled: ReturnType<typeof assemble> | undefined;
function harness() {
  if (assembled) return assembled;
  const visits: Visit[] = [];
  for (const [i, value] of values.entries()) {
    const macro = loadConstant(p, fromNumber(i === 0 ? 0 : values[i - 1]), value);
    if (macro.length) macro[macro.length - 1].label = `result${value}`;
    visits.push(...macro, visit("OUT"));
  }
  visits.push(visit("HALT"));
  return assembled = assemble({
    blocks: [{ label: "J", op: "j" }, p, { label: "OUT", op: "<" }, { label: "HALT", op: "v" }],
    tapes: [
      { label: "entry", movdTarget: false, visits: [visit("J", ref("main", -1))] },
      { label: "main", movdTarget: true, visits },
    ],
    entry: "entry",
  });
}

describe("small-constant macro", () => {
  it("loads every small value from every small accumulator at either P address", () => {
    // Exercise transitions, including carries across ternary digit boundaries.
    for (const address of [81, 85]) {
      for (let from = 0; from <= 80; from++) {
        for (let to = 0; to <= 80; to++) {
          let a = fromNumber(from);
          for (const v of loadConstant({ ...p, address }, a, to)) {
            if (v.operand.kind !== "const") throw new Error("expected constant");
            a = crazy(a, fromNumber(v.operand.value));
          }
          expect(a).toBe(fromNumber(to));
        }
      }
    }
  });

  it("assembles and runs values across ternary boundaries at widths 10 and 20", () => {
    const asm = harness();
    expect(asm.symbols.get("P")).toBe(81);
    const std = StandardMachine.fromSource(asm.source);
    expect(std.run(1_000_000)).toBe("halted");
    for (const value of values.slice(1)) {
      expect(std.mem[asm.symbols.get(`result${value}`)! + 1]).toBe(value);
    }
    const expected = values.map((n) => String.fromCodePoint(n)).join("");
    expect(String.fromCharCode(...std.output)).toBe(expected);
    for (const width of [10, 20]) {
      const machine = UnshackledMachine.fromSource(asm.source, "", fixedWidthPolicy(width));
      const result = machine.run(1_000_000);
      expect(result, machine.crashReason).toBe("halted");
      expect(machine.outputString()).toBe(expected);
      for (const value of values.slice(1)) {
        expect(machine.read(fromNumber(asm.symbols.get(`result${value}`)! + 1))).toBe(fromNumber(value));
      }
    }
  });

  for (const [oracle, available] of [[ORACLE, hasOracle], [ORACLE20, hasOracle20]] as const) {
    it.skipIf(!available)(`matches external interpreter ${oracle}`, () => {
      expect(runOracleSource(harness().source, oracle)).toBe(values.map((n) => String.fromCodePoint(n)).join(""));
    });
  }

  it("rejects unsupported constants and unpinned blocks", () => {
    expect(() => loadConstant({ label: "P", op: "p" }, "0", 1)).toThrow(/pinned/);
    expect(() => loadConstant({ ...p, address: 82 }, "0", 1)).toThrow(/pinned/);
    for (const value of [-1, 1.5, 81, NaN]) expect(() => loadConstant(p, "0", value)).toThrow(/0 through 80/);
    expect(() => loadConstant(p, "bad", 1)).toThrow(/accumulator/);
    expect(() => assemble({ blocks: [{ ...p, address: 82 }], tapes: [{ label: "main", movdTarget: false, visits: [] }], entry: "main" })).toThrow(/no legal placement/);
  });
});
