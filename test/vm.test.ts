import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleBytecode, runVM, type BytecodeProgram } from "../src/vm/index.js";

const run = (source: string, width = 10) => runVM(assembleBytecode(source, { width }));

describe("reference stack VM", () => {
  it.each([10, 20])("runs hand-written fizzbuzz at width %i", (width) => {
    const source = readFileSync(new URL("../examples/fizzbuzz.vm", import.meta.url), "utf8");
    const program = assembleBytecode(source, { width });
    const result = runVM(program);
    const expected = Array.from({ length: 100 }, (_, index) => {
      const n = index + 1;
      return (n % 3 === 0 ? "Fizz" : "") + (n % 5 === 0 ? "Buzz" : "") || String(n);
    }).join("\n") + "\n";
    expect(result.status).toBe("halted");
    expect(result.output).toBe(expected);
    expect(result.locals[0]).toBe(101n);
    expect(result.stack).toEqual([]);
    expect(result.returnStack).toEqual([]);
  });

  it.each([10, 20])("wraps signed arithmetic at width %i", (width) => {
    const half = (3n ** BigInt(width) - 1n) / 2n;
    expect(run(`push ${half}\npush 1\nadd\nhalt`, width).stack).toEqual([-half]);
    expect(run(`push ${-half}\npush 1\nsub\nhalt`, width).stack).toEqual([half]);
    expect(run(`push ${3n ** BigInt(width)}\nhalt`, width).stack).toEqual([0n]);
    expect(run(`push ${half}\npush 2\nmul\nhalt`, width).stack).toEqual([-1n]);
  });

  it.each([
    ["div", -2n], ["mod", -1n], ["lt", 1n], ["le", 1n], ["eq", 0n],
  ])("defines signed %s with left/right operand order", (op, expected) => {
    expect(run(`push -7\npush 3\n${op}\nhalt`).stack).toEqual([expected]);
  });

  it("supports shared locals, nested calls, stack operations and consuming branches", () => {
    const result = run(`
      push 7
      store 0
      call outer
      push 0
      jz done
      push 999
      done: halt
      outer: load 0
      call inner
      ret
      inner: dup
      push 2
      swap
      drop
      sub
      ret
    `);
    expect(result.stack).toEqual([5n]);
    expect(result.locals).toEqual([7n]);
    expect(result.returnStack).toEqual([]);
  });

  it("reads Unicode code points and returns -1 at EOF", () => {
    const code = assembleBytecode("getc\nputc\ngetc\nputc\ngetc\nhalt", { width: 20 });
    const result = runVM(code, { input: "🙂\n" });
    expect(result.output).toBe("🙂\n");
    expect(result.stack).toEqual([-1n]);
    expect(() => runVM(assembleBytecode("getc\nhalt"), { input: "🙂" })).toThrow(/word width/);
    expect(() => run("push -1\nputc\nhalt")).toThrow(/Unicode/);
    expect(() => run("push 55296\nputc\nhalt", 20)).toThrow(/Unicode/);
  });

  it("bounds loops and rejects malformed execution", () => {
    const loop = assembleBytecode("loop: jump loop");
    expect(runVM(loop, { maxSteps: 25 })).toMatchObject({ status: "step-limit", steps: 25, pc: 0 });
    expect(runVM(loop, { maxSteps: 0 }).steps).toBe(0);
    for (const op of ["add", "store 0", "putc", "dup", "drop", "swap", "ret"]) {
      expect(() => run(`${op}\nhalt`)).toThrow(/underflow/);
    }
    expect(() => run("push 3\npush 0\ndiv\nhalt")).toThrow(/division by zero/);
    expect(() => run("push 1")).toThrow(/fell off/);
    expect(() => runVM(loop, { maxSteps: -1 })).toThrow(/maxSteps/);
    const bad: BytecodeProgram = { width: 10, localCount: 0, instructions: [{ op: "jump", target: 1 }] };
    expect(() => runVM(bad)).toThrow(/invalid jump target/);
  });
});

describe("text bytecode assembler", () => {
  it("resolves forward labels and comments, and infers local count", () => {
    expect(assembleBytecode("jump end # forward\nload 2\nend: halt")).toEqual({
      width: 10, localCount: 3,
      instructions: [{ op: "jump", target: 2 }, { op: "load", index: 2 }, { op: "halt" }],
    });
  });
  it.each([
    "jump missing", "a: halt\na: halt", "push 1.5", "push", "halt 1", "wat",
    "store -1", "load 1000000", "jump end\nend:", "push 1 2",
  ])("rejects malformed bytecode: %s", (source) => {
    expect(() => assembleBytecode(source)).toThrow(/<assembly>:\d+:\d+:/);
  });
  it("validates widths and explicit local counts", () => {
    for (const width of [9, 10.5, Infinity, 1025]) expect(() => assembleBytecode("halt", { width })).toThrow(/width/);
    expect(() => assembleBytecode("load 1\nhalt", { localCount: 1 })).toThrow(/localCount/);
  });
});
