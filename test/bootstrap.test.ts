import { beforeAll, describe, expect, it } from "vitest";
import { assembleBootstrap, type BootstrapImage } from "../src/hell/bootstrap.js";
import { UnshackledMachine, minimalPolicy, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, fromNumber, toBigInt } from "../src/malbolge/trits.js";
import { hasOracle, ORACLE, runOracleSource } from "./helpers.js";

describe("input-free bootstrap with unknown rotation width", () => {
  let program: BootstrapImage;
  beforeAll(() => { program = assembleBootstrap(20); }, 30_000);
  it.each(["minimal", "random", "large-slack"])("installs and executes from legal source under %s growth", (policyName) => {
    const policy = policyName === "minimal" ? minimalPolicy(10) : policyName === "random" ? referencePolicy(17) :
      { initialWidth: 29, grow: (current: number, width: number) => Math.max(current, 2 * width + 19) };
    const m = UnshackledMachine.fromSource(program.source, "", policy);
    expect(m.run(30_000_000), m.crashReason).toBe("halted");
    const basis = toBigInt(m.read(fromNumber(program.basisRegister)))! / 2n;
    expect(basis).toBeGreaterThan(BigInt(program.source.length));
    const payload = program.symbols.get("payload")!, marker = program.symbols.get("marker")!;
    expect(toBigInt(m.read(fromBigInt(BigInt(payload.bank) * basis + BigInt(payload.offset))))).toBe(2n * 3n ** 20n);
    expect(toBigInt(m.read(fromBigInt(BigInt(marker.bank) * basis + BigInt(marker.offset))))).toBe(3n);
    expect(m.rotWidth).toBeGreaterThanOrEqual(66);
    expect(m.outputString()).toBe("");
  }, 60_000);
  it.skipIf(!hasOracle)("also installs and terminates in the unrestricted-width C interpreter", () => {
    expect(runOracleSource(program.source, ORACLE)).toBe("");
  }, 30_000);
  it("validates shifts and source budgets", () => {
    for (const shift of [-1, 1.5, 31]) expect(() => assembleBootstrap(shift)).toThrow(/shift/);
    expect(() => assembleBootstrap(20, 1000)).toThrow(/budget/);
  });
});
