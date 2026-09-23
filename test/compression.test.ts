import { describe, expect, it } from "vitest";
import { compileJS } from "../src/frontend/index.js";
import { assembleBytecode, planHeLLVM, runVM } from "../src/vm/index.js";
import { stackBound } from "../src/vm/stack-bound.js";
import { planPaddingInstaller } from "../src/vm/installer.js";
import { bootstrapCycleImage, installBootstrap, type BankWord } from "../src/hell/bootstrap.js";
import { fromBigInt, fromNumber, toBigInt } from "../src/malbolge/trits.js";
import { UnshackledMachine, minimalPolicy, referencePolicy } from "../src/malbolge/unshackled.js";
import { valueForOp } from "../src/hell/cycles.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import { runMicroModel } from "./micro-model.js";
import { setImmediate } from "node:timers/promises";

async function run(m: UnshackledMachine, limit: number) {
  let status: ReturnType<typeof m.run> = "step-limit";
  while (status === "step-limit" && m.steps < limit) { status = m.run(Math.min(m.steps + 1_000_000, limit)); await setImmediate(); }
  expect(status, m.crashReason).toBe("halted");
}

describe("compiler compression", () => {
  it("removes numeric formatting, dead functions, and constant branch bodies", () => {
    const source = 'function unused(x){return x*x;} if(false)console.log(999); console.log(19+23);';
    const program = compileJS(source);
    expect(program.localCount).toBe(0);
    expect(program.instructions.map((i) => i.op)).toEqual(["putci", "putci", "putci", "halt"]);
    expect(runVM(program).output).toBe("42\n");
    expect(compileJS(source, { optimize: false }).instructions.length).toBeGreaterThan(program.instructions.length);
  });
  it.each([
    "console.log(29524+1,-29524-1,101*1000,-17/5,-17%5);",
    "let x=1;console.log(x,x=2,x++);console.log(x);",
    "function f(n){if(n<1)return 1;return n*f(n-1);}console.log(f(5));",
    "let x=0;while(x<5){x++;if(x===2)continue;console.log(x);}console.log(x);",
  ])("preserves modular arithmetic, side effects, and faults: %s", (source) => {
    const a = runVM(compileJS(source, { width: 10 })), b = runVM(compileJS(source, { width: 10, optimize: false }));
    expect(a.status).toBe(b.status); expect(a.output).toBe(b.output);
  });
  it.each(["/", "%"])("retains division-by-zero faults for %s", (operator) => {
    for (const optimize of [true, false]) expect(() => runVM(compileJS(`console.log(1${operator}0);`, { optimize }))).toThrow(/division by zero/);
  });
  it("proves stack bounds conservatively and honors explicit capacities", () => {
    const program = assembleBytecode("push 1\npush 2\nadd\nhalt");
    expect(stackBound(program)).toBe(2);
    expect(planHeLLVM(program, { optimize: "size" }).stackCapacity).toBe(2);
    expect(planHeLLVM(program, { optimize: "size", stackCapacity: 1 }).stackCapacity).toBe(1);
    expect(stackBound(assembleBytecode("again: push 1\njump again"))).toBeUndefined();
    expect(stackBound(assembleBytecode("again: call again"))).toBeUndefined();
    expect(stackBound(assembleBytecode("drop\nhalt"))).toBeUndefined();
  });
  it.each([10, 20])("size arithmetic agrees across signed boundaries at width %i", (width) => {
    const half = (3n ** BigInt(width) - 1n) / 2n;
    const code = [-half, -101n, -1n, 0n, 1n, 101n, half].flatMap((value) => [-5, 1, 3, 10, 31, 32].flatMap((d) => ["divi", "modi"].map((op) => `push ${value}\n${op} ${d}`))).join("\n");
    const program = assembleBytecode(code + "\nhalt", { width });
    for (const optimize of ["size", "speed"] as const) {
      const actual = runMicroModel(planFullHeLLVM(program, { optimize, stackCapacity: 100 }));
      expect(actual.fault).toBe(0); expect(actual.stack).toEqual(runVM(program).stack);
    }
  }, 120_000);
});

describe("target-side run decoder", () => {
  it.each([1, 8, 29, 83])("fills %i cells across ternary carries and all six fill phases", async (length) => {
    const loader = planPaddingInstaller({ patches: [], next: { bank: 650, offset: 80 } }, { start: 18, end: 18 + length })!;
    const basis = 3n ** 60n, address = (at: BankWord) => fromBigInt(BigInt(at.bank) * basis + BigInt(at.offset));
    const m = UnshackledMachine.fromSource(">&", "", referencePolicy(length));
    for (const p of loader.patches) m.write(address(p.at), typeof p.value === "string" ? p.value : address(p.value));
    m.write(address(bootstrapCycleImage(59, true).symbols.get("one.0")!), "1");
    m.write(address(loader.resume), address({ bank: 188, offset: 2 }));
    m.write(address({ bank: 188, offset: 2 }), fromNumber(74));
    m.write(address({ bank: 188, offset: 3 }), fromNumber(valueForOp("v", 3)));
    const before = m.read(address({ bank: 564, offset: 17 })), after = m.read(address({ bank: 564, offset: 18 + length }));
    m.c = address({ ...loader.entry, offset: loader.entry.offset + 1 }); m.d = address({ ...loader.next, offset: loader.next.offset + 1 });
    await run(m, 100_000_000);
    expect(m.c).toBe(address({ bank: 188, offset: 3 }));
    for (let i = 0; i < length; i++) expect(toBigInt(m.read(address({ bank: 564, offset: 18 + i })))).toBe(74n);
    expect(m.read(address({ bank: 564, offset: 17 }))).toBe(before);
    expect(m.read(address({ bank: 564, offset: 18 + length }))).toBe(after);
  }, 120_000);
  it("bootstraps the decoder, resumes installation, and executes from legal source", async () => {
    const plan = planHeLLVM(assembleBytecode("putci 65\nputci 10\nhalt"), { stackCapacity: 0 });
    const installer = planPaddingInstaller(plan, { start: 18, end: 48 })!;
    const image = installBootstrap(bootstrapCycleImage(59, true), 30, 500_000_000, 3, plan, { installer });
    expect(Object.values(image.statistics.phases).reduce((a, b) => a + b, 0)).toBe(image.source.length);
    expect(image.statistics.generatedPaddingCells).toBe(30);
    const m = UnshackledMachine.fromSource(image.source, "", minimalPolicy());
    await run(m, 250_000_000);
    expect(m.outputString()).toBe("A\n");
    const basis = toBigInt(m.read(fromNumber(image.basisRegister)))! / 2n;
    expect(m.c).toBe(fromBigInt(188n * basis + 3n));
  }, 180_000);
});
