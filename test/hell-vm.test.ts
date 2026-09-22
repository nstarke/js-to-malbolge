import { beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { assembleBytecode, assembleHeLLVM, encodeBytecode, planHeLLVM, normalizeWord, runVM, wordModulus } from "../src/vm/index.js";
import { UnshackledMachine, minimalPolicy, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, fromNumber, toBigInt } from "../src/malbolge/trits.js";
import type { BankWord } from "../src/hell/bootstrap.js";
import { hasOracle, ORACLE, runOracleSourceAsync } from "./helpers.js";
import { compileJS } from "../src/frontend/index.js";

const resolveAt = (basis: bigint) => (p: BankWord) => fromBigInt(BigInt(p.bank) * basis + BigInt(p.offset));
function snapshot(plan: ReturnType<typeof planHeLLVM>, m: UnshackledMachine, basis: bigint) {
  const resolve = resolveAt(basis), read = (p: BankWord) => m.read(resolve(p));
  const pc = plan.records.findIndex((r) => read(plan.symbols.get("pc")!) === resolve(r.pointer));
  const sp = read(plan.symbols.get("sp")!);
  const pointers = plan.stackCapacity === 1 ? sp === resolve(plan.empty.pointer) ? [] : [sp] :
    plan.stack.slice(1, plan.stack.findIndex((r) => resolve(r.pointer) === sp) + 1).map((r) => read(r.fields[0]));
  const stack = pointers.map((pointer) => {
    const literal = plan.records.find((r) => resolve(r.pointer) === pointer)!;
    return normalizeWord(toBigInt(read(literal.fields[1]))!, wordModulus(plan.program.width));
  });
  const fault = [...plan.faults].find(([, at]) => m.c === resolve({ ...at, offset: at.offset + 1 }))?.[0];
  return { pc, stack, fault };
}
function installed(source: string, capacity: number, width = 10) {
  const program = assembleBytecode(source, { width }), plan = planHeLLVM(encodeBytecode(program), { stackCapacity: capacity });
  const basis = 3n ** 60n, resolve = resolveAt(basis);
  const m = UnshackledMachine.fromSource("QP", "", referencePolicy(19));
  // Isolate native execution; separate tests below install from legal source.
  m.write(resolve(plan.symbols.get("$bank.one")!), "1");
  for (const patch of plan.patches) m.write(resolve(patch.at), typeof patch.value === "string" ? patch.value : resolve(patch.value));
  m.c = resolve({ ...plan.entry, offset: plan.entry.offset + 1 });
  m.d = resolve({ ...plan.next, offset: plan.next.offset + 1 });
  return { program, plan, basis, resolve, m };
}

describe("shared HeLL bytecode handlers", () => {
  it.each([1, 3])("matches the reference VM with stack capacity %i", (capacity) => {
    const source = capacity === 1 ? "push 65\nputc\npush 66\nputc\npush -1\nhalt" :
      "push 65\npush 66\nputc\npush 10\nputc\nputc\npush -1\nhalt";
    const { program, plan, basis, resolve, m } = installed(source, capacity);
    const expected = runVM(program);
    expect(m.run(5_000_000), m.crashReason).toBe("halted");
    expect(m.outputString()).toBe(expected.output);
    expect(snapshot(plan, m, basis)).toEqual({ pc: expected.pc, stack: expected.stack, fault: 0 });
    // Fetch and literal reads preserve data, including dispatch pointers.
    for (const record of plan.records.slice(0, -1)) for (const at of record.fields) {
      const patch = plan.patches.find((p) => p.at.bank === at.bank && p.at.offset === at.offset)!;
      expect(m.read(resolve(at))).toBe(typeof patch.value === "string" ? patch.value : resolve(patch.value));
    }
  });

  it.each([1, 2])("supports Unicode and newline with stack capacity %i", (capacity) => {
    const { program, m, plan, basis } = installed("push 128578\nputc\npush 10\nputc\nhalt", capacity, 20);
    expect(m.run(5_000_000), m.crashReason).toBe("halted");
    expect(m.outputString()).toBe(runVM(program).output);
    expect(snapshot(plan, m, basis).fault).toBe(0);
  });

  it.each([
    ["putc", 1, 10, 1], ["putc", 3, 10, 1],
    ["push 65\npush 66\nhalt", 1, 10, 2], ["push 65\nhalt", 0, 10, 2],
    ["push 1\npush 2\npush 3\nhalt", 2, 10, 2],
    ["push -1\nputc\nhalt", 1, 10, 3], ["push 55296\nputc\nhalt", 2, 20, 3],
    ["push 1114112\nputc\nhalt", 1, 20, 3],
    ["", 1, 10, 4], ["push 65\nputc", 2, 10, 4],
  ] as const)("halts with a runtime fault for %j (capacity %i)", (source, capacity, width, fault) => {
    const { m, plan, basis } = installed(source, capacity, width);
    expect(m.run(5_000_000), m.crashReason).toBe("halted");
    expect(snapshot(plan, m, basis).fault).toBe(fault);
  });

  it("keeps handler code fixed and fetches changed operand data at runtime", () => {
    const first = installed("push 65\nputc\nhalt", 2);
    const second = planHeLLVM(assembleBytecode("push 90\nputc\npush 89\nputc\nhalt"), { stackCapacity: 2 });
    const code = (p: typeof second) => p.patches.filter((patch) => patch.at.bank === p.entry.bank);
    expect(code(first.plan)).toEqual(code(second));
    first.m.write(first.resolve(first.plan.records[0].fields[1]), fromNumber(90));
    expect(first.m.run(5_000_000), first.m.crashReason).toBe("halted");
    expect(first.m.outputString()).toBe("Z");
  });

  it("selects the complete interpreter and rejects invalid backend options", () => {
    expect(planHeLLVM(assembleBytecode("push 1\npush 2\nadd\nhalt")).kind).toBe("microcode");
    expect(planHeLLVM(assembleBytecode(".locals 1\nhalt")).kind).toBe("microcode");
    expect(() => planHeLLVM(assembleBytecode(".width 21\nhalt"))).toThrow(/width/);
    for (const stackCapacity of [-1, 1.5, 1_000_001]) expect(() => planHeLLVM(assembleBytecode("halt"), { stackCapacity })).toThrow(/capacity/);
    expect(() => assembleHeLLVM(assembleBytecode("halt"), { maxSourceCells: 1000 })).toThrow(/budget/);
  });
});

describe("bytecode interpreter installed from legal Malbolge source", () => {
  let image: ReturnType<typeof assembleHeLLVM>;
  beforeAll(() => {
    image = assembleHeLLVM(encodeBytecode(compileJS('console.log("AB");', { width: 10 })), { stackCapacity: 1 });
  }, 60_000);
  it.each(["minimal", "random"])("fetches and executes bytecode under %s growth", async (policy) => {
    const m = UnshackledMachine.fromSource(image.source, "", policy === "minimal" ? minimalPolicy() : referencePolicy(17));
    let status: ReturnType<typeof m.run> = "step-limit";
    while (status === "step-limit" && m.steps < 150_000_000) { status = m.run(m.steps + 500_000); await setImmediate(); }
    expect(status, m.crashReason).toBe("halted");
    expect(m.outputString()).toBe("AB\n");
    const basis = toBigInt(m.read(fromNumber(image.basisRegister)))! / 2n;
    expect(snapshot(image.vm, m, basis)).toEqual({ pc: 6, stack: [], fault: 0 });
  }, 180_000);
  it.skipIf(!hasOracle)("matches the unrestricted-width C interpreter", async () => {
    expect(await runOracleSourceAsync(image.source, ORACLE)).toBe("AB\n");
  }, 180_000);
  it("installs the linked stack and executes nested pushes", async () => {
    const linked = assembleHeLLVM(assembleBytecode("push 65\npush 66\nputc\nputc\nhalt"), { stackCapacity: 2 });
    const m = UnshackledMachine.fromSource(linked.source, "", minimalPolicy());
    let status: ReturnType<typeof m.run> = "step-limit";
    while (status === "step-limit" && m.steps < 150_000_000) { status = m.run(m.steps + 500_000); await setImmediate(); }
    expect(status, m.crashReason).toBe("halted");
    expect(m.outputString()).toBe("BA");
    const basis = toBigInt(m.read(fromNumber(linked.basisRegister)))! / 2n;
    expect(snapshot(linked.vm, m, basis)).toEqual({ pc: 4, stack: [], fault: 0 });
  }, 180_000);
});
