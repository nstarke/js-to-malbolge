import { describe, expect, it } from "vitest";
import { assembleBytecode, runVM } from "../src/vm/index.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import { compileJS } from "../src/frontend/index.js";
import { runMicroModel } from "./micro-model.js";
import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { UnshackledMachine, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, toBigInt } from "../src/malbolge/trits.js";
import type { BankWord } from "../src/hell/bootstrap.js";

describe("bytecode routines on the register microcode model", () => {
  it("runs the complete compiled FizzBuzz fixture", () => {
    const program = compileJS(readFileSync(new URL("../examples/fizzbuzz.js", import.meta.url), "utf8"), { width: 10 });
    const actual = runMicroModel(planFullHeLLVM(program, {}));
    expect(actual).toMatchObject({ fault: 0, output: runVM(program).output, stack: [] });
  }, 60_000);
  it.each([10, 20])("matches immediate division and remainder across signed boundaries at width %i", (width) => {
    const half = (3n ** BigInt(width) - 1n) / 2n;
    const values = [-half, -half + 1n, -101n, -16n, -1n, 0n, 1n, 16n, 101n, half - 1n, half];
    const source = values.flatMap((v) => [1, -1, 3, -5, 10, 15, 32, 33].flatMap((d) => ["modi", "divi"].map((op) => `push ${v}\n${op} ${d}`))).join("\n") + "\nhalt";
    const program = assembleBytecode(source, { width }), actual = runMicroModel(planFullHeLLVM(program, { stackCapacity: 200 }));
    expect(actual.fault).toBe(0); expect(actual.stack).toEqual(runVM(program).stack);
  }, 60_000);
  it.each([
    ["divi 3", 1], ["divi 0", 1], ["push 1\ndivi 0", 7], ["modi 3", 1], ["modi 0", 1], ["push 1\nmodi 0", 7],
    ["putci -1", 3], [".width 20\nputci 55296", 3], [".width 20\nputci 1114112", 3],
  ])("preserves immediate-operation faults: %s", (source, fault) => {
    expect(runMicroModel(planFullHeLLVM(assembleBytecode(source as string), {})).fault).toBe(fault);
  });
  it("prints immediate Unicode without consuming the data stack", () => {
    const program = assembleBytecode(".width 20\npush 7\nputci 128578\nputci 10\nhalt");
    const actual = runMicroModel(planFullHeLLVM(program, { stackCapacity: 1 }));
    expect(actual).toMatchObject({ fault: 0, output: "🙂\n", stack: [7n] });
  });
  it.each([10, 20])("matches arithmetic boundary cases at width %i", (width) => {
    const half = (3n ** BigInt(width) - 1n) / 2n;
    const pairs = [[half, 2n], [-half, -1n], [1n, half], [-10n, 3n], [0n, -7n], [81n, -27n]];
    const source = pairs.flatMap(([a, b]) => ["add", "sub", "mul", "div", "mod", "eq", "lt", "le"].map((op) => `push ${a}\npush ${b}\n${op}`)).join("\n") + "\nhalt";
    const program = assembleBytecode(source, { width }), actual = runMicroModel(planFullHeLLVM(program, { stackCapacity: 64 }));
    expect(actual.fault, `micro steps=${actual.steps}`).toBe(0);
    expect(actual.stack).toEqual(runVM(program).stack);
  }, 60_000);
  it.each([
    "push 2\npush 3\nadd\nhalt",
    "push 29524\npush 1\nadd\npush -29524\npush 1\nsub\nhalt",
    "push 5\npush -3\nlt\npush -5\npush -3\nlt\npush 0\npush 0\neq\nhalt",
    "push 1\npush 2\nswap\ndup\nstore 0\ndrop\nload 0\nhalt",
    "push 0\njz yes\npush 9\nyes: call f\nhalt\nf: push 7\nret",
    "push 7\npush -6\nmul\npush -4\npush -9\nmul\nhalt",
    "push 17\npush 5\ndiv\npush 17\npush 5\nmod\nhalt",
    "push -17\npush 5\ndiv\npush -17\npush 5\nmod\nhalt",
    "push 17\npush -5\ndiv\npush -17\npush -5\nmod\nhalt",
    "push -29524\npush -1\ndiv\npush 0\npush 3\ndiv\nhalt",
    "push 65\nstore 0\nload 0\nputc\nhalt",
    "getc\ngetc\ngetc\nhalt",
  ])("matches reference execution: %s", (source) => {
    const program = assembleBytecode(source), expected = runVM(program, { input: "A\n" });
    const actual = runMicroModel(planFullHeLLVM(program, { stackCapacity: 32 }), "A\n");
    expect(actual.fault, `micro steps=${actual.steps}`).toBe(0);
    expect(actual).toMatchObject({ output: expected.output, pc: expected.pc, stack: expected.stack, locals: expected.locals });
  }, 60_000);
  it.each([
    ["putc", {}, 1], ["push 1\npush 2", { stackCapacity: 1 }, 2], ["push -1\nputc", {}, 3],
    ["", {}, 4], ["ret", {}, 5], ["again: call again", { returnStackCapacity: 1 }, 6],
    ["push 1\npush 0\ndiv", {}, 7], ["push 1\npush 0\nmod", {}, 7], ["getc", {}, 8],
  ] as const)("detects runtime faults: %s", (source, options, fault) => {
    const plan = planFullHeLLVM(assembleBytecode(source), options);
    expect(runMicroModel(plan, "🙂").fault).toBe(fault);
  }, 60_000);
  it("runs compiled control flow, functions, and decimal output", () => {
    const program = compileJS("function twice(x){return x+x;} for(let i=1;i<=3;i++)console.log(twice(i));", { width: 10 });
    const expected = runVM(program), actual = runMicroModel(planFullHeLLVM(program, { stackCapacity: 64 }));
    expect(actual.fault, `micro steps=${actual.steps}`).toBe(0);
    expect(actual.output).toBe(expected.output);
    expect(actual.stack).toEqual([]);
  }, 60_000);
});

describe("native execution of shared arithmetic", () => {
  it.each([10, 20])("executes signed comparisons and immediate arithmetic at width %i", async (width) => {
    const program = assembleBytecode("push -17\nmodi 5\npush 17\nmodi -3\npush 0\nmodi 1\npush -17\ndivi 5\npush 17\ndivi -3\npush 17\ndivi 10\npush -29524\npush 29524\nlt\npush 7\npush 7\nle\nputci 65\nhalt", { width });
    const plan = planFullHeLLVM(program, { stackCapacity: 12 }), basis = 3n ** 60n;
    const resolve = (p: BankWord) => fromBigInt(BigInt(p.bank) * basis + BigInt(p.offset));
    const m = UnshackledMachine.fromSource("QP", "", referencePolicy(19));
    m.write(resolve(plan.microcode.layout.one), "1");
    for (const p of plan.patches) m.write(resolve(p.at), typeof p.value === "string" ? p.value : resolve(p.value));
    m.c = resolve({ ...plan.entry, offset: plan.entry.offset + 1 }); m.d = resolve({ ...plan.next, offset: plan.next.offset + 1 });
    let status: ReturnType<typeof m.run> = "step-limit";
    while (status === "step-limit" && m.steps < 600_000_000) { status = m.run(m.steps + 1_000_000); await setImmediate(); }
    expect(status, m.crashReason).toBe("halted");
    expect(m.c).toBe(resolve({ ...plan.faults.get(0)!, offset: plan.faults.get(0)!.offset + 1 }));
    const expected = runVM(program), modulus = 3n ** BigInt(width);
    expect(m.outputString()).toBe(expected.output);
    expect(m.read(resolve(plan.symbols.get("sp")!))).toBe(resolve(plan.stack[expected.stack.length].pointer));
    expected.stack.forEach((value, i) => expect(toBigInt(m.read(resolve(plan.stack[i + 1].fields[0])))).toBe((value + modulus) % modulus));
  }, 120_000);
  it("fetches bytecode and computes addition in the growing-width machine", async () => {
    const plan = planFullHeLLVM(assembleBytecode("push 19\npush 23\nadd\nhalt"), { stackCapacity: 2 });
    const basis = 3n ** 60n, resolve = (p: BankWord) => fromBigInt(BigInt(p.bank) * basis + BigInt(p.offset));
    const m = UnshackledMachine.fromSource("QP", "", referencePolicy(19));
    m.write(resolve(plan.microcode.layout.one), "1");
    for (const p of plan.patches) m.write(resolve(p.at), typeof p.value === "string" ? p.value : resolve(p.value));
    m.c = resolve({ ...plan.entry, offset: plan.entry.offset + 1 }); m.d = resolve({ ...plan.next, offset: plan.next.offset + 1 });
    let status: ReturnType<typeof m.run> = "step-limit";
    while (status === "step-limit" && m.steps < 150_000_000) { status = m.run(m.steps + 500_000); await setImmediate(); }
    expect(status, `${m.crashReason}; steps=${m.steps}`).toBe("halted");
    expect(m.c).toBe(resolve({ ...plan.faults.get(0)!, offset: plan.faults.get(0)!.offset + 1 }));
    expect(toBigInt(m.read(resolve(plan.stack[1].fields[0])))).toBe(42n);
    expect(m.read(resolve(plan.symbols.get("sp")!))).toBe(resolve(plan.stack[1].pointer));
  }, 180_000);
});
