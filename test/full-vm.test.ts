import { describe, expect, it } from "vitest";
import { assembleBytecode, runVM } from "../src/vm/index.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import { compileJS } from "../src/frontend/index.js";
import { runMicroModel } from "./micro-model.js";
import { setImmediate } from "node:timers/promises";
import { UnshackledMachine, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, toBigInt } from "../src/malbolge/trits.js";
import type { BankWord } from "../src/hell/bootstrap.js";

describe("bytecode routines on the register microcode model", () => {
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
