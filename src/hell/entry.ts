/**
 * Program entry code.
 *
 * Cell 0 is always '(' (a j): D := 40, then 41. From there C and D advance in
 * lockstep, so straight-line code at cell k operates on cell 40 + k. The entry
 * code ends with a j at cell m reading the steering cell 40 + m, then a Jmp at
 * m + 1 that reads the first tape word at [40 + m] + 1.
 *
 * When the program uses the double-j block at 59..65, the entry code also
 * patches its gap cells 61..63 into permanent nops: `p` instructions at cells
 * 21..23 write crazy(A, cell) there, with A steered by earlier `p`s on free
 * scratch cells among 41..60.
 */
import { crazy, fromNumber, toBigInt, type Trits } from "../malbolge/trits.js";
import { permanentNopValues, validValues, valueForOp } from "./cycles.js";

export interface EntryPlan {
  /** Values for cells 0..m+1. */
  code: number[];
  /** Scratch cells written by the entry code: address -> initial value. */
  scratch: Map<number, number>;
  /** Address of the steering cell and its value (may be a double-j cell). */
  steer: { addr: number; value: number };
  /** First tape word address = steer.value + 1. */
  start: number;
  /** Gap cell values for the double-j block (61, 62, 63), if patched. */
  gap?: [number, number, number];
}

/** Plan a plain entry without patching: cells 0..2 and steering cell 41. */
export function plainEntryPlans(isFree: (a: number) => boolean): EntryPlan[] {
  const out: EntryPlan[] = [];
  if (![0, 1, 2, 41].every(isFree)) return out;
  for (const v of validValues(41)) {
    out.push({ code: [40, valueForOp("j", 1), valueForOp("i", 2)], scratch: new Map(), steer: { addr: 41, value: v }, start: v + 1 });
  }
  return out;
}

/**
 * Plan an entry that patches the double-j gap cells. `isFree(a)` says whether
 * cell a may be used as scratch or code. Returns candidates ordered by start.
 */
const permNopCache = new Map<number, Set<number>>();
function permNops(addr: number): Set<number> {
  let s = permNopCache.get(addr);
  if (!s) {
    s = new Set(permanentNopValues(addr));
    permNopCache.set(addr, s);
  }
  return s;
}

export function patchingEntryPlans(isFree: (a: number) => boolean): EntryPlan[] {
  // Phase A: cells 1..20 operate on 41..60; find base-1 values of A reachable
  // with the fewest scratch writes.
  type Path = (number | null)[]; // per cell 1..20: constant written, or null for nop
  let layer = new Map<Trits, { pCount: number; path: Path }>([["0", { pCount: 0, path: [] }]]);
  for (let k = 1; k <= 20; k++) {
    const addr = 40 + k;
    const next = new Map<Trits, { pCount: number; path: Path }>();
    const consider = (a: Trits, entry: { pCount: number; path: Path }) => {
      const cur = next.get(a);
      if (!cur || cur.pCount > entry.pCount) next.set(a, entry);
    };
    for (const [a, e] of layer) {
      consider(a, { pCount: e.pCount, path: [...e.path, null] });
      if (!isFree(addr)) continue;
      for (const c of validValues(addr)) consider(crazy(a, fromNumber(c)), { pCount: e.pCount + 1, path: [...e.path, c] });
    }
    layer = next;
  }

  // Phase B: patch 61, detour through s1/s2, patch 62, detour through s3/s4,
  // patch 63. The detour cells are forced by the legal-value constraints:
  // cell 62 holds s1 - 1, [s2] = 61, cell 63 holds s3 - 1, [s4] = 62.
  const variants = [
    { s1: 37, s3: 71 },
    { s1: 72, s3: 36 },
  ];
  const out: EntryPlan[] = [];
  const isBase0Value = (t: Trits, set: Set<number>) => {
    const v = toBigInt(t);
    return v !== null && v >= 33n && v <= 126n && set.has(Number(v));
  };
  for (const { s1, s3 } of variants) {
    const s2 = s1 + 1;
    const s4 = s3 + 1;
    if (![s1, s2, s3, s4].every(isFree)) continue;
    const c62 = s1 - 1;
    const c63 = s3 - 1;
    if (!validValues(62).includes(c62) || !validValues(63).includes(c63)) continue;
    if (!validValues(s2).includes(61) || !validValues(s4).includes(62)) continue;
    let found: { a1: Trits; path: Path; c61: number; cs1: number; cs3: number } | null = null;
    const sortedA1 = [...layer.entries()].sort((x, y) => x[1].pCount - y[1].pCount);
    for (const [a1, e] of sortedA1) {
      for (const c61 of validValues(61)) {
        const g1 = crazy(a1, fromNumber(c61));
        if (!isBase0Value(g1, permNops(61))) continue;
        for (const cs1 of validValues(s1)) {
          const a2 = crazy(g1, fromNumber(cs1));
          const g2 = crazy(a2, fromNumber(c62));
          if (!isBase0Value(g2, permNops(62))) continue;
          for (const cs3 of validValues(s3)) {
            const a3 = crazy(g2, fromNumber(cs3));
            const g3 = crazy(a3, fromNumber(c63));
            if (!isBase0Value(g3, permNops(63))) continue;
            found = { a1, path: e.path, c61, cs1, cs3 };
            break;
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) break;
    }
    if (!found) continue;
    const code: number[] = [40];
    const scratch = new Map<number, number>();
    found.path.forEach((c, idx) => {
      const k = idx + 1;
      if (c === null) code.push(valueForOp("o", k));
      else {
        code.push(valueForOp("p", k));
        scratch.set(40 + k, c);
      }
    });
    // C=21 p@61, 22 j, 23 p@s1, 24 j, 25 p@62, 26 j, 27 p@s3, 28 j, 29 p@63
    code.push(valueForOp("p", 21), valueForOp("j", 22), valueForOp("p", 23), valueForOp("j", 24), valueForOp("p", 25));
    code.push(valueForOp("j", 26), valueForOp("p", 27), valueForOp("j", 28), valueForOp("p", 29));
    scratch.set(s1, found.cs1);
    scratch.set(s2, 61);
    scratch.set(s3, found.cs3);
    scratch.set(s4, 62);
    const gap: [number, number, number] = [found.c61, c62, c63];
    // After C=29, D=64, so D = C + 34 from here on. Cells 30..m-1 are nops and
    // cell m is a j reading the steering cell 34 + m.
    for (let m = 30; m <= 45; m++) {
      if (!isFree(m) || !isFree(m + 1) || scratch.has(m) || scratch.has(m + 1)) break;
      const steerAddr = 34 + m;
      if (scratch.has(steerAddr)) continue;
      const codeM = [...code];
      for (let k = 30; k < m; k++) codeM.push(valueForOp("o", k));
      codeM.push(valueForOp("j", m), valueForOp("i", m + 1));
      const push = (value: number) =>
        out.push({ code: codeM, scratch: new Map(scratch), steer: { addr: steerAddr, value }, start: value + 1, gap });
      if (steerAddr === 64) push(70);
      else if (steerAddr === 65) push(valueForOp("i", 65));
      else if (isFree(steerAddr)) for (const v of validValues(steerAddr)) push(v);
    }
  }
  return out.sort((x, y) => x.start - y.start);
}
