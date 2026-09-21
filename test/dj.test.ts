import { describe, expect, it } from "vitest";
import { assemble, describeLayout, visit } from "../src/hell/assemble.js";
import { constant, movd, ref, type Program } from "../src/hell/ir.js";
import { runStandard, StandardMachine } from "../src/malbolge/standard.js";
import { fixedWidthPolicy, minimalPolicy, referencePolicy, runUnshackled, UnshackledMachine } from "../src/malbolge/unshackled.js";
import { fromNumber } from "../src/malbolge/trits.js";
import { isValidAt } from "../src/hell/cycles.js";

import { hasOracle, hasOracle20, ORACLE, ORACLE20, runOracleSource } from "./helpers.js";

const runBoth = (source: string, input: string, maxSteps: number) => {
  const std = runStandard(source, { input, maxSteps });
  const uns = [minimalPolicy(), fixedWidthPolicy(20), referencePolicy(9)].map((policy) => runUnshackled(source, { input, maxSteps, policy }));
  return { std, uns };
};

describe("double-j block", () => {
  it("assembles a cat loop whose MovDs go through the double-j block", () => {
    const prog: Program = {
      blocks: [{ label: "DJ", op: "dj" }, { label: "IN", op: "/" }, { label: "OUT", op: "<" }],
      tapes: [
        { label: "entry", movdTarget: false, visits: [visit("DJ", movd("loop"))] },
        { label: "loop", movdTarget: true, visits: [visit("IN"), visit("OUT"), visit("DJ", movd("loop"))] },
      ],
      entry: "entry",
    };
    const asm = assemble(prog);
    const { std, uns } = runBoth(asm.source, "cat via dj\n", 30000);
    expect(std.status, describeLayout(asm)).toBe("step-limit");
    expect(std.output.startsWith("cat via dj\n")).toBe(true);
    for (const u of uns) {
      expect(u.status, u.crashReason).toBe("step-limit");
      expect(u.output.startsWith("cat via dj\n")).toBe(true);
    }
  });

  it("performs a computed MovD through a register written at run time", () => {
    // EOF supplies ...222. A crazy write of source value 123 turns it into
    // 237, so DJ reads a runtime-built pointer beyond the printable range.
    const initial = 123;
    const landing = 237;
    const prog: Program = {
      blocks: [
        { label: "DJ", op: "dj" }, { label: "P", op: "p" },
        { label: "IN", op: "/" }, { label: "OUT", op: "<" }, { label: "HALT", op: "v" },
      ],
      tapes: [
        {
          label: "entry", movdTarget: false,
          visits: [visit("IN"), visit("P", constant(initial), "wr"), visit("DJ", ref("wr", -3))],
        },
        {
          label: "land", movdTarget: true, fixedStart: landing + 1,
          visits: [visit("OUT"), visit("HALT")],
        },
      ],
      entry: "entry",
    };
    const asm = assemble(prog);
    expect(asm.image[asm.symbols.get("wr")! + 1]).toBe(initial);
    expect(asm.symbols.get("wr")! + 1).toBeLessThanOrEqual(130);
    const { std, uns } = runBoth(asm.source, "", 100000);
    expect(std.status, describeLayout(asm)).toBe("halted");
    expect(std.output).toBe(String.fromCodePoint(landing));
    if (hasOracle) expect(runOracleSource(asm.source, ORACLE)).toBe(String.fromCodePoint(landing));
    // The fixed-width C dialect emits raw bytes, while Unshackled emits UTF-8.
    if (hasOracle20) expect(runOracleSource(asm.source, ORACLE20, "", "latin1")).toBe(String.fromCodePoint(landing));
    const stdMachine = StandardMachine.fromSource(asm.source);
    const unsMachine = UnshackledMachine.fromSource(asm.source);
    expect(stdMachine.run(100000)).toBe("halted");
    expect(unsMachine.run(100000)).toBe("halted");
    const register = asm.symbols.get("wr")! + 1;
    expect(stdMachine.mem[register]).toBe(landing);
    expect(unsMachine.read(fromNumber(register))).toBe(fromNumber(landing));
    for (const u of uns) {
      expect(u.status, u.crashReason).toBe("halted");
      expect(u.output).toBe(String.fromCodePoint(landing));
    }
  });

  it("documents why the original source value 74 cannot be a computed-jump register", () => {
    for (const pointer of [81, 85]) {
      const legal = Array.from({ length: 130 }, (_, address) => address)
        .filter((address) => isValidAt(pointer, address) && isValidAt(74, address + 1));
      // wr-3 must be printable, so wr <=129. The sole pair collides with P.
      expect(legal).toEqual(pointer === 81 ? [81] : []);
    }
  });

  it("reports the incompatible rotation and double-j block placements", () => {
    expect(() => assemble({
      blocks: [{ label: "DJ", op: "dj" }, { label: "ROT", op: "*" }],
      tapes: [{ label: "entry", movdTarget: false, visits: [] }], entry: "entry",
    })).toThrow(/rotation block overlaps/);
  });
});
