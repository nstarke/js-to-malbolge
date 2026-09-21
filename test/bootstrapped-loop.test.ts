import { beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { Arithmetic, assembleBootstrappedLoop, planBootstrappedLoop, type BankWord, type BootstrappedLoopImage } from "../src/hell/index.js";
import { UnshackledMachine, minimalPolicy, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, fromNumber, toBigInt } from "../src/malbolge/trits.js";
import { hasOracle, ORACLE, runOracleSourceAsync } from "./helpers.js";

describe("register applications linked to the growing-width bootstrap", () => {
  let program: BootstrappedLoopImage;
  beforeAll(() => {
    program = assembleBootstrappedLoop({
      width: 10, registers: { value: 65, again: 0 },
      body: [{ op: "putc", source: "value" }, { op: "getc", dest: "again" }], while: "again",
    });
  }, 60_000);

  it.each(["minimal", "random"])("installs and repeats from legal source under %s growth", async (policy) => {
    const m = UnshackledMachine.fromSource(program.source, "\x01\0", policy === "minimal" ? minimalPolicy() : referencePolicy(17));
    let status: ReturnType<UnshackledMachine["run"]> = "step-limit";
    // Yield between batches so long integration runs do not block Vitest's RPC.
    while (status === "step-limit" && m.steps < 100_000_000) {
      status = m.run(m.steps + 500_000);
      await setImmediate();
    }
    expect(status, m.crashReason).toBe("halted");
    expect(m.outputString()).toBe("AA");
    const basis = toBigInt(m.read(fromNumber(program.basisRegister)))! / 2n;
    const resolve = (at: BankWord) => fromBigInt(BigInt(at.bank) * basis + BigInt(at.offset));
    expect(basis).toBeGreaterThan(BigInt(program.source.length));
    expect(toBigInt(m.read(resolve(program.applicationSymbols.get("value")!)))).toBe(65n);
    expect(toBigInt(m.read(resolve(program.applicationSymbols.get("again")!)))).toBe(0n);
  }, 180_000);

  it.skipIf(!hasOracle)("installs and repeats in the unrestricted-width C interpreter", async () => {
    expect(await runOracleSourceAsync(program.source, ORACLE, "\x01\0")).toBe("AA");
  }, 180_000);
});

describe("banked application runtime", () => {
  it.each([[10, 132], [20, 177]])("reuses logical rotations and indexed aliases at logical width %i, physical width %i", (width, physicalWidth) => {
    const ar = new Arithmetic(width), initial = 3n ** BigInt(width - 1) + 5n;
    const plan = planBootstrappedLoop({
      width, registers: { ...ar.registers, value: initial, pointer: 0, digit: 0, again: 0 }, arrays: { data: [0, 0] },
      body: [
        { op: "getc", dest: "pointer" }, { op: "rotate", dest: "value", count: width + 1 },
        { op: "store", pointer: "pointer", source: "value" }, { op: "set", dest: "value", value: 0 },
        { op: "load", dest: "pointer", pointer: "pointer" }, { op: "copy", dest: "value", source: "pointer" },
        ...ar.trit("digit", "value", 1), { op: "putc", source: "digit" }, { op: "getc", dest: "again" },
      ], while: "again",
    });
    // Source installation is tested above. Isolate the larger runtime here,
    // resolving the same symbolic patches against a representative bank basis.
    const basis = 3n ** 60n, resolve = (at: BankWord) => fromBigInt(BigInt(at.bank) * basis + BigInt(at.offset));
    const m = UnshackledMachine.fromSource("QP", "O\x01R\x01O\0", minimalPolicy(physicalWidth));
    for (const patch of plan.patches) m.write(resolve(patch.at), typeof patch.value === "string" ? patch.value : resolve(patch.value));
    m.c = resolve({ ...plan.entry, offset: plan.entry.offset + 1 });
    m.d = resolve({ ...plan.next, offset: plan.next.offset + 1 });
    expect(m.run(20_000_000), m.crashReason).toBe("halted");
    const expected: bigint[] = [];
    let value = initial;
    for (let i = 0; i < 3; i++) { value = value / 3n + value % 3n * 3n ** BigInt(width - 1); expected.push(value); }
    expect(m.outputString()).toBe(expected.map((word) => String.fromCharCode(Number(word / 3n % 3n))).join(""));
    expect(toBigInt(m.read(resolve(plan.applicationSymbols.get("value")!)))).toBe(expected[2]);
    const cells = plan.arrays.get("data")!.cells;
    expect(toBigInt(m.read(resolve(cells[0])))).toBe(expected[2]);
    expect(toBigInt(m.read(resolve(cells[1])))).toBe(expected[1]);
    expect(toBigInt(m.read(resolve(plan.registerSymbols.get("$max")!)))).toBe(728n * basis + 3n ** 31n - 1n);
  }, 120_000);

  it("rejects invalid application contracts before installation", () => {
    const program = { width: 10, registers: { flag: 0 }, body: [], while: "flag" };
    expect(() => planBootstrappedLoop({ ...program, while: "missing" })).toThrow(/unknown register/);
    expect(() => planBootstrappedLoop({ ...program, registers: { flag: 0, $reserved: 0 } })).toThrow(/reserved/);
    expect(() => planBootstrappedLoop({ ...program, arrays: { empty: [] } })).toThrow(/empty/);
    expect(() => planBootstrappedLoop({ ...program, body: [{ op: "require-width", width: 20 }] })).toThrow(/width/);
    expect(() => planBootstrappedLoop({ ...program, body: [{ op: "rotate", dest: "flag", count: -1 }] })).toThrow(/rotation count/);
    expect(() => planBootstrappedLoop({ ...program, registers: { flag: "1" }, body: [{ op: "rotate", dest: "flag" }] })).toThrow(/finite/);
    expect(() => assembleBootstrappedLoop(program, { maxSourceCells: 1000 })).toThrow(/budget/);
  });
});
