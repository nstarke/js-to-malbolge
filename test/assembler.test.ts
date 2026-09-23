import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AssemblyError, assembleBytecode, assembleBytecodeDetailed, disassembleBytecode, encodeBytecode, inspectBytecode, runVM } from "../src/vm/index.js";

const bytes = (source: string) => encodeBytecode(assembleBytecode(source));
describe("assembly language", () => {
  it("runs the documented assembler example", () => {
    const source = readFileSync(new URL("../examples/assembler-demo.vm", import.meta.url), "utf8");
    expect(runVM(assembleBytecode(source)).output).toBe("HeLLVM 🙂\nABC\n");
  });
  it("resolves forward constants, scoped labels, named locals, and expressions", () => {
    const source = `.width WORD_BITS
.equ WORD_BITS, 20
.equ FIRST = 'A'
.local counter
start: push FIRST + (0x10 >> 4)
store counter
.loop: load counter
putc
jump done
other: .loop: putci 'X'
jump .loop
done: .println "🙂 # ; //"
halt
.assert done > start, "wrong order"
`;
    const result = assembleBytecodeDetailed(source, { filename: "sample.vm" });
    expect(runVM(result.program).output).toBe("B🙂 # ; //\n");
    expect(result.program.localCount).toBe(1);
    expect(result.symbols.get("start.loop")).toMatchObject({ kind: "label", value: 2n });
    expect(result.symbols.get("other.loop")).toMatchObject({ kind: "label", value: 5n });
    expect(result.symbols.get("WORD_BITS")).toMatchObject({ kind: "constant", value: 20n });
    expect(result.sourceMap[0]).toMatchObject({ pc: 0, location: { filename: "sample.vm", line: 5, column: 8 } });
    expect(bytes(disassembleBytecode(result.program))).toEqual(encodeBytecode(result.program));
  });
  it.each([
    ["0xff + 0b10 + 0o7 + 0t12", 269n],
    ["1_000 + 2 * 3 - 4", 1002n], ["-(7 / 3)", -2n], ["-7 % 3", -1n],
    ["1 << 2 + 1", 8n], ["~0 & 0xff", 255n], ["(3 ^ 1) | 8", 10n],
    ["1 < 2", 1n], ["1 <= 1", 1n], ["2 > 3", 0n], ["2 >= 2", 1n],
    ["3 == 3", 1n], ["3 != 3", 0n], ["!0", 1n], ["+7", 7n],
    ["'\\n'", 10n], ["'\\x41'", 65n], ["'\\u0041'", 65n], ["'\\u{1f642}'", 128578n],
  ] as const)("evaluates %s using exact integers", (expression, value) => {
    expect(assembleBytecode(`push ${expression}`).instructions).toEqual([{ op: "push", value }]);
  });
  it("uses instruction indices for numeric branches and $", () => {
    const program = assembleBytecode("push 65\nputc\njump $+2\nputci 88\nhalt");
    expect(runVM(program).output).toBe("A");
    expect(program.instructions[2]).toEqual({ op: "jump", target: 4 });
  });
  it("accepts all comment forms without stripping quoted characters", () => {
    const source = '.print "#;//\\\"\\\\" ; tail\r\nputci \'#\' // tail\rhalt # tail';
    expect(runVM(assembleBytecode(source)).output).toBe('#;//"\\#');
  });
  it("allocates locals around explicit indices and infers their count", () => {
    const result = assembleBytecodeDetailed(".local fixed, 0\n.local automatic\n.local alias = 0\npush 7\nstore automatic\nhalt");
    expect(result.symbols.get("automatic")?.value).toBe(1n);
    expect(result.program.localCount).toBe(2);
    expect(() => assembleBytecode(".locals 1\n.local x, 1")).toThrow(/localCount/);
  });
  it("supports includes through an explicit resolver and retains file locations", () => {
    const files: Record<string, string> = { "constants.vm": ".equ LETTER, 'Q'", "body.vm": "putci LETTER\nhalt" };
    const result = assembleBytecodeDetailed('.include "constants.vm"\n.include "body.vm"', {
      filename: "main.vm", resolveInclude: (name, from) => { expect(from).toBe("main.vm"); return { filename: name, source: files[name] }; },
    });
    expect(runVM(result.program).output).toBe("Q");
    expect(result.sourceMap[0].location.filename).toBe("body.vm");
    expect(() => assembleBytecode('.include "a"')).toThrow(/resolver/);
    expect(() => assembleBytecode('.include "a"', { filename: "a", resolveInclude: () => ({ filename: "a", source: "" }) })).toThrow(/cycle/);
    expect(() => assembleBytecode('.include "missing"', { resolveInclude: () => { throw new Error("absent"); } })).toThrow(/cannot include missing: absent/);
  });
  it("validates text width even when a directive follows a label", () => {
    expect(() => assembleBytecode('start: .print "🙂"')).toThrow(/larger width/);
    expect(runVM(assembleBytecode('.width 20\nstart: .println "\\uD83D\\uDE42"\nhalt')).output).toBe("🙂\n");
    // The explicit instruction retains its ordinary runtime validation.
    expect(assembleBytecode("putci 55296").instructions).toEqual([{ op: "putci", value: 55296n }]);
  });
  it.each([
    [".equ A, B\n.equ B, A\nhalt", /cyclic constant/],
    [".equ A, 1\nA: halt", /duplicate symbol/],
    [".local x\n.local x", /duplicate symbol/],
    [".loop: halt", /preceding global/],
    ["jump nowhere", /unknown symbol/], ["end: jump after\nafter:", /empty jump/],
    ["push 1 / 0", /division by zero/], ["push 1 << -1", /shift count/], ["push 1 << 65537", /shift count/],
    ["push 0x_1", /separator/], ["push 1__0", /separator/], ["push 0t3", /unexpected token/],
    ["push (1+2", /expected/], ["push 1 2", /unexpected token/],
    ["push 'ab'", /one Unicode scalar/], ["push '\\ud800'", /one Unicode scalar/],
    ['.print "\\ud800"', /Unicode scalar/], ['.print "\\q"', /unknown escape/],
    ['.print "unterminated', /unterminated/], ['.print "\\xZZ"', /invalid character escape/],
    ['.assert 0, "broken invariant"', /broken invariant/],
    ["halt\n.width 20", /header/], [".local x, -1", /local index/],
  ] as const)("rejects %s with a source location", (source, message) => {
    try { assembleBytecode(source, { filename: "bad.vm" }); throw new Error("expected assembly failure"); }
    catch (error) { expect(error).toBeInstanceOf(AssemblyError); expect(error).toHaveProperty("filename", "bad.vm"); expect(String(error)).toMatch(message); }
  });
  it("bounds text expansion", () => {
    expect(() => assembleBytecode('.print "abc"', { maxInstructions: 2 })).toThrow(/instruction budget/);
    expect(assembleBytecode("", { maxInstructions: 0 }).instructions).toEqual([]);
  });
  it("handles long expressions and rejects excessive nesting with a source diagnostic", () => {
    expect(assembleBytecode(`push ${Array(10_000).fill("1").join("+")}`).instructions).toEqual([{ op: "push", value: 10_000n }]);
    for (const expression of ["-".repeat(300) + "1", "(".repeat(300) + "1" + ")".repeat(300)]) {
      expect(() => assembleBytecode(`push ${expression}`)).toThrow(/expression nesting/);
    }
  });
});

describe("disassembly and inspection", () => {
  it.each(["decimal", "hex", "ternary"] as const)("round-trips annotated %s output byte for byte", (radix) => {
    const original = bytes(".width 20\nstart: push -123456\nmodi 17\ndivi -3\nputci 'A'\nload 2\nstore 1\njz start\ncall done\ndone: halt");
    const text = disassembleBytecode(original, { radix, annotate: true });
    expect(text).toContain("offset=0x10"); expect(text).toContain("bytes=01");
    expect(bytes(text)).toEqual(original);
  });
  it("reports instruction offsets, operand widths, branch destinations, and bytes", () => {
    const program = assembleBytecode("top: push -1\njump top\nhalt"), info = inspectBytecode(program);
    expect(info).toMatchObject({ format: "MBVM", version: 1, width: 10, byteLength: 25, wordBytes: 2 });
    expect(info.instructions).toMatchObject([
      { pc: 0, offset: 16, size: 3, opcode: 1, op: "push", operand: "-1", label: "L0000", bytes: "01 a8 e6" },
      { pc: 1, offset: 19, size: 5, op: "jump", operand: "L0000", target: 0 },
      { pc: 2, offset: 24, size: 1, op: "halt" },
    ]);
    expect(() => JSON.stringify(info)).not.toThrow();
  });
  it("preserves supplied labels, avoids generated-name collisions, and allows end labels", () => {
    const program = assembleBytecode("begin: push 1\njump begin\nhalt");
    const labels = new Map([[1, "L0000"], [3, "end"]]);
    const text = disassembleBytecode(program, { labels });
    expect(text).toContain("L0000_1:"); expect(text).toContain("end:");
    expect(bytes(text)).toEqual(encodeBytecode(program));
    expect(() => disassembleBytecode(program, { labels: new Map([[0, "bad:name"]]) })).toThrow(/label/);
    expect(() => disassembleBytecode(program, { labels: new Map([[99, "bad"]]) })).toThrow(/label/);
  });
});
