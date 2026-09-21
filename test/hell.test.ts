import { describe, expect, it } from "vitest";
import { assemble, describeLayout, visit } from "../src/hell/assemble.js";
import { isValidAt, permanentOResidues, restorableResidues, validValues } from "../src/hell/cycles.js";
import { constant, ref, type Program } from "../src/hell/ir.js";
import { runStandard } from "../src/malbolge/standard.js";
import { fixedWidthPolicy, minimalPolicy, referencePolicy, runUnshackled } from "../src/malbolge/unshackled.js";
import { crazy, fromNumber, type Trits } from "../src/malbolge/trits.js";

describe("cycle facts", () => {
  it("every address has eight legal values; permanent o exists at some residues", () => {
    for (let a = 0; a < 94 * 3; a++) expect(validValues(a).length).toBe(8);
    const res = permanentOResidues();
    expect(res.length).toBeGreaterThan(5);
    // consecutive residues are needed for the 3-word nop block
    expect(res.some((r) => res.includes(r + 1))).toBe(true);
  });
  it("restorable residues", () => {
    expect(restorableResidues("j")).toEqual([60, 64]);
    expect(restorableResidues("*")).toEqual([59, 63]);
    expect(restorableResidues("p")).toEqual([82, 86]);
    expect(restorableResidues("<")).toEqual([25, 29]);
    expect(restorableResidues("/")).toEqual([43, 47]);
  });
});

const baseBlocks: Program["blocks"] = [{ label: "J", op: "j" }];

describe("assembler", () => {
  it("assembles a cat loop that runs on both interpreters", () => {
    const prog: Program = {
      blocks: [...baseBlocks, { label: "IN", op: "/" }, { label: "OUT", op: "<" }],
      tapes: [
        { label: "entry", movdTarget: false, visits: [visit("J", ref("loop", -1))] },
        { label: "loop", movdTarget: true, visits: [visit("IN"), visit("OUT"), visit("J", ref("loop", -1))] },
      ],
      entry: "entry",
    };
    const asm = assemble(prog);
    expect(asm.size, describeLayout(asm)).toBeLessThan(400);
    const std = runStandard(asm.source, { input: "hello cat\n", maxSteps: 20000 });
    expect(std.status).toBe("step-limit");
    expect(std.output.startsWith("hello cat\n")).toBe(true);
    for (const policy of [minimalPolicy(), fixedWidthPolicy(20), referencePolicy(5)]) {
      const u = runUnshackled(asm.source, { input: "unshackled cat\n", maxSteps: 20000, policy });
      expect(u.status, u.crashReason).toBe("step-limit");
      expect(u.output.startsWith("unshackled cat\n")).toBe(true);
    }
  });

  it("prints a string built from crazy-op chains and halts", () => {
    // Crazy-op chains from printable constants cannot cross between values < 81
    // and >= 81 (trit 4 of every constant is 0 or 1), so keep all chars < 81.
    const text = "HELLO, HELL!\n";
    const blocks: Program["blocks"] = [...baseBlocks, { label: "P", op: "p" }, { label: "OUT", op: "<" }, { label: "HALT", op: "v" }];
    // Learn the P block's pointer value from a probe layout.
    const probe = assemble({ blocks, tapes: [{ label: "entry", movdTarget: false, visits: [visit("HALT")] }], entry: "entry" });
    const pPtr = probe.symbols.get("P")!;
    // Constants c for which some residue a has ptr valid at a and c valid at a+1.
    const packable: number[] = [];
    for (let c = 33; c <= 126; c++) {
      let ok = false;
      for (let a = 0; a < 94 && !ok; a++) if (isValidAt(pPtr, a) && isValidAt(c, a + 1)) ok = true;
      if (ok) packable.push(c);
    }
    expect(packable.length).toBeGreaterThan(20);

    // BFS over A for each character.
    const chain = (from: Trits, to: Trits): number[] | null => {
      if (from === to) return [];
      const prev = new Map<Trits, { from: Trits; c: number } | null>([[from, null]]);
      let frontier = [from];
      for (let depth = 0; depth < 30 && frontier.length; depth++) {
        const next: Trits[] = [];
        for (const a of frontier) {
          for (const c of packable) {
            const b = crazy(a, fromNumber(c));
            if (prev.has(b)) continue;
            prev.set(b, { from: a, c });
            if (b === to) {
              const out: number[] = [];
              let cur: Trits = b;
              while (cur !== from) {
                const p = prev.get(cur)!;
                out.push(p.c);
                cur = p.from;
              }
              return out.reverse();
            }
            next.push(b);
          }
        }
        frontier = next;
      }
      return null;
    };

    const visits = [];
    let a: Trits = "0";
    for (const ch of text) {
      const goal = fromNumber(ch.charCodeAt(0));
      const cs = chain(a, goal);
      expect(cs, `no chain for ${ch}`).not.toBeNull();
      for (const c of cs!) visits.push(visit("P", constant(c)));
      visits.push(visit("OUT"));
      a = goal;
    }
    visits.push(visit("HALT"));
    const prog: Program = {
      blocks,
      tapes: [
        { label: "entry", movdTarget: false, visits: [visit("J", ref("main", -1))] },
        { label: "main", movdTarget: true, visits },
      ],
      entry: "entry",
    };
    const asm = assemble(prog);
    const r = runStandard(asm.source);
    expect(r.status, describeLayout(asm)).toBe("halted");
    expect(r.output).toBe(text);
    for (const policy of [minimalPolicy(), referencePolicy(3), fixedWidthPolicy(20)]) {
      const u = runUnshackled(asm.source, { policy });
      expect(u.status, u.crashReason).toBe("halted");
      expect(u.output).toBe(text);
    }
  });
});
