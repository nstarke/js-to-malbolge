/**
 * Analysis of the xlat2 encryption permutation: which instruction sequences a
 * single cell can execute over its lifetime, depending on its address mod 94.
 * Run: pnpm tsx scripts/analyze-xlat.ts
 */
import { XLAT2, decodeOp, type Mnemonic } from "../src/malbolge/tables.js";

const enc = (v: number) => XLAT2.charCodeAt(v - 33);

// Cycle decomposition.
const seen = new Set<number>();
const cycles: number[][] = [];
for (let v = 33; v <= 126; v++) {
  if (seen.has(v)) continue;
  const cyc: number[] = [];
  let x = v;
  while (!seen.has(x)) {
    seen.add(x);
    cyc.push(x);
    x = enc(x);
  }
  cycles.push(cyc);
}
console.log("xlat2 cycle lengths:", cycles.map((c) => c.length).sort((a, b) => a - b).join(" "));
for (const c of cycles) console.log("  cycle", c.map((v) => String.fromCharCode(v)).join(""));

// For each address residue, classify each cycle by the instruction sequence it yields.
type Seq = Mnemonic[];
const perAddr: Map<number, { permanentNop: number[]; pairs: Map<string, number[]> }> = new Map();
const summary = new Map<string, number>();
for (let addr = 0; addr < 94; addr++) {
  const permanentNop: number[] = [];
  const pairs = new Map<string, number[]>();
  for (const cyc of cycles) {
    const seq: Seq = cyc.map((v) => decodeOp(v, addr));
    const nonNop = seq.filter((m) => m !== "nop" && m !== "o");
    if (nonNop.length === 0) permanentNop.push(...cyc);
    if (cyc.length === 2) {
      const key = seq.join(",");
      const entry = pairs.get(key) ?? [];
      entry.push(cyc[0]);
      pairs.set(key, entry);
    }
    if (cyc.length >= 2 && nonNop.length === 1) {
      const k = `len${cyc.length}:${nonNop[0]}+nops`;
      summary.set(k, (summary.get(k) ?? 0) + 1);
    }
  }
  perAddr.set(addr, { permanentNop, pairs });
}

const twoCycleKinds = new Map<string, number>();
for (const [, info] of perAddr) {
  for (const [k] of info.pairs) twoCycleKinds.set(k, (twoCycleKinds.get(k) ?? 0) + 1);
}
console.log("\n2-cycle instruction pairs and the number of address residues offering them:");
for (const [k, n] of [...twoCycleKinds].sort()) console.log(`  ${k.padEnd(12)} ${n}`);

console.log("\nLonger cycles with exactly one real instruction:");
for (const [k, n] of [...summary].sort()) console.log(`  ${k.padEnd(20)} ${n} residues`);

const minNop = Math.min(...[...perAddr.values()].map((i) => i.permanentNop.length));
console.log(`\npermanent-nop values per address: min ${minNop}`);

// Which residues offer each restorable pair (X, nop) in either order.
console.log("\nResidues offering restorable instruction X (2-cycle X/nop):");
for (const X of ["j", "i", "*", "p", "<", "/", "v"]) {
  const res: number[] = [];
  for (const [addr, info] of perAddr) {
    if (info.pairs.has(`${X},nop`) || info.pairs.has(`nop,${X}`) || info.pairs.has(`${X},o`) || info.pairs.has(`o,${X}`)) res.push(addr);
  }
  console.log(`  ${X}: ${res.length} residues: ${res.join(" ")}`);
}
