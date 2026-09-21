import { describe, expect, it } from "vitest";
import { Arithmetic, assembleRegisters, fixedWord, type RegisterInstruction } from "../src/hell/index.js";
import { fixedWidthPolicy, UnshackledMachine } from "../src/malbolge/unshackled.js";
import { crazy, fromNumber, rotate, toBigInt, tritAt } from "../src/malbolge/trits.js";
import { hasOracle20, ORACLE20, runOracleSource } from "./helpers.js";

// A fast word-level check of the generated circuits, independent of source layout.
function circuit(ar: Arithmetic, code: RegisterInstruction[], a: bigint, b: bigint) {
  const regs = new Map(Object.entries({ ...ar.registers, a, b, result: 0 }).map(([k, v]) => [k, fixedWord(v, ar.width)]));
  for (const i of code) {
    switch (i.op) {
      case "require-width": expect(i.width).toBe(ar.width); break;
      case "copy": regs.set(i.dest, regs.get(i.source)!); break;
      case "crazy": regs.set(i.dest, crazy(regs.get(i.a)!, regs.get(i.b)!)); break;
      case "rotate": for (let n = 0; n < (i.count ?? 1); n++) regs.set(i.dest, rotate(regs.get(i.dest)!, ar.width)); break;
      case "set": regs.set(i.dest, fixedWord(i.value, ar.width)); break;
      default: throw new Error("unexpected I/O in circuit");
    }
  }
  return regs;
}

describe("reusable arithmetic", () => {
  it("rejects arithmetic compiled for a different rotation width", () => {
    const ar = new Arithmetic(20);
    expect(() => assembleRegisters({ width: 10, registers: { a: 0, b: 0, result: 0, ...ar.registers },
      instructions: ar.add("result", "a", "b") })).toThrow(/does not match program width/);
  });
  it.each([10, 20])("checks ternary boundaries and signed overflow against bigint at width %i", (width) => {
    const ar = new Arithmetic(width), modulus = 3n ** BigInt(width), half = (modulus - 1n) / 2n;
    const values = [0n, 1n, 2n, 3n, 8n, 9n, 26n, 27n, 80n, 81n, half, half + 1n, modulus - 2n, modulus - 1n];
    const signed = (v: bigint) => v > half ? v - modulus : v;
    for (const [method, code] of [
      ["add", ar.add("result", "a", "b")], ["subtract", ar.subtract("result", "a", "b")],
      ["less", ar.lessThan("result", "a", "b")], ["unsigned", ar.lessThan("result", "a", "b", false)],
      ["equal", ar.equal("result", "a", "b")],
    ] as const) {
      for (const a of values) for (const b of values) {
        const expected = method === "add" ? (a + b) % modulus : method === "subtract" ? (a - b + modulus) % modulus :
          BigInt(method === "less" ? signed(a) < signed(b) : method === "unsigned" ? a < b : a === b);
        const regs = circuit(ar, code, a, b);
        expect(toBigInt(regs.get("result")!), `${method}(${a},${b})`).toBe(expected);
        expect(toBigInt(regs.get("a")!)).toBe(a);
        expect(toBigInt(regs.get("b")!)).toBe(b);
      }
    }
  });

  it.each([10, 20])("executes addition, subtraction, increment, comparisons and reuse at width %i", (width) => {
    const ar = new Arithmetic(width), modulus = 3n ** BigInt(width);
    const instructions: RegisterInstruction[] = [
      ...ar.increment("a"), // max -> 0, with input/output aliasing
      ...ar.add("a", "a", "b"), // 0 + 81 -> 81
      ...ar.subtract("result", "a", "b"), // 0
      ...ar.equal("result", "result", "a"), // false
      { op: "putc", source: "result" },
      ...ar.lessThan("result", "b", "a"), // equal -> false
      { op: "putc", source: "result" },
      ...ar.subtract("a", "result", "b"), // -81, aliases input
      ...ar.lessThan("result", "a", "b"), // -81 < 81
      { op: "putc", source: "result" },
      ...ar.equal("result", "b", "b"), // true
      { op: "putc", source: "result" },
    ];
    const asm = assembleRegisters({ width, registers: { a: -1, b: 81, result: 0, ...ar.registers }, instructions });
    const m = UnshackledMachine.fromSource(asm.source, "", fixedWidthPolicy(width));
    expect(m.run(5_000_000), m.crashReason).toBe("halted");
    expect(m.outputString()).toBe("\0\0\x01\x01");
    expect(toBigInt(m.read(fromNumber(asm.symbols.get("a")!)))).toBe(modulus - 81n);
    expect(toBigInt(m.read(fromNumber(asm.symbols.get("b")!)))).toBe(81n);
  });

  it.skipIf(!hasOracle20).each(["add", "subtract", "increment", "lessThan", "equal"] as const)(
    "%s executes on changing inputs and matches the fixed-width C oracle", (operation) => {
      const width = 20, ar = new Arithmetic(width), modulus = 3n ** BigInt(width);
      const a = operation === "equal" ? 65n : modulus - 1n;
      const code = operation === "increment" ? ar.increment("result", "b") : ar[operation]("result", "a", "b");
      const instructions: RegisterInstruction[] = [{ op: "getc", dest: "b" }, ...code];
      for (let i = 0; i < width; i++) instructions.push(...ar.trit("digit", "result", i), { op: "putc", source: "digit" });
      const asm = assembleRegisters({ width, registers: { a, b: 0, result: 0, digit: 0, ...ar.registers }, instructions });
      for (const input of ["A", "B", "z"]) {
        const b = BigInt(input.charCodeAt(0));
        const value = operation === "add" ? (a + b) % modulus : operation === "subtract" ? (a - b + modulus) % modulus :
          operation === "increment" ? b + 1n : operation === "lessThan" ? 1n : BigInt(a === b);
        const word = fixedWord(value, width);
        const expected = Array.from({ length: width }, (_, i) => String.fromCharCode(tritAt(word, i))).join("");
        const m = UnshackledMachine.fromSource(asm.source, input, fixedWidthPolicy(width));
        expect(m.run(1_000_000), m.crashReason).toBe("halted");
        expect(m.outputString()).toBe(expected);
        expect(runOracleSource(asm.source, ORACLE20, input)).toBe(expected);
      }
    },
  );
});
