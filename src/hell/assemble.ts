/**
 * Assembler: places code blocks and tape segments in memory, chooses cell
 * values, and emits Malbolge source. See ir.ts for the execution model.
 *
 * Address constraints:
 * - A restorable block [entry][op][jmp] needs its op cell at a residue (mod 94)
 *   where the F/J two-cycle alternates op/nop. Its pointer value is the entry
 *   address, which must be a legal source char (33..126), so blocks live in
 *   [33, 126].
 * - Any tape segment that is a MovD target needs address <= 127 for the same
 *   reason. Segments that are only walked into can be anywhere.
 * - Every cell of the source must decode to a real instruction at its address.
 *   The packer inserts visits to nop blocks (2 or 3 words) between visits so
 *   that every fixed word lands on an address where it is legal.
 */
import { fillerValue, isValidAt, permanentO, restorableValue, valueForOp } from "./cycles.js";
import { type BlockOp, type CodeBlock, type Program, type TapeSegment, type Visit, type WordSpec, junk, ref } from "./ir.js";


export class AssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssembleError";
  }
}

export interface Assembled {
  source: string;
  image: Uint8Array;
  /** label -> address (blocks: entry cell; tapes: first word; visit labels: pointer word). */
  symbols: Map<string, number>;
  /** Address of the last cell used by the program. */
  size: number;
  /** Final layout of each tape segment, for debugging. */
  layout: { label: string; start: number; words: { addr: number; value: number; note: string }[] }[];
}

interface PlacedBlock {
  block: CodeBlock;
  entry: number;
  cells: number[];
}

/** A tape visit after expansion: pointer word + operand words. */
interface XVisit {
  block: string;
  operands: WordSpec[]; // 1 for normal blocks, 2 for nop2
  label?: string;
  inserted?: boolean;
}

/** Expand visits, adding restore visits. */
function expandTape(seg: TapeSegment, blocks: Map<string, CodeBlock>): XVisit[] {
  const out: XVisit[] = [];
  const push = (v: Visit) => {
    const b = blocks.get(v.block);
    if (!b) throw new AssembleError(`unknown block ${v.block} in segment ${seg.label}`);
    const operands = b.op === "nop2" ? [v.operand, junk()] : b.op === "jmp" ? [] : [v.operand];
    out.push(v.label ? { block: v.block, operands, label: v.label } : { block: v.block, operands });
  };
  if (seg.movdTarget && ![...blocks.values()].some((b) => b.op === "j")) {
    throw new AssembleError(`segment ${seg.label} is a MovD target but there is no j block`);
  }
  for (const v of seg.visits) push(v);
  return out;
}

function blockCandidates(b: CodeBlock): { entry: number; cells: number[] }[] {
  const out: { entry: number; cells: number[] }[] = [];
  for (let entry = 33; entry <= 126; entry++) {
    const opAddr = entry + 1;
    const cells: number[] = [fillerValue(entry)];
    if (b.op === "jmp") {
      cells.push(valueForOp("i", opAddr));
    } else if (b.op === "nop") {
      const o = permanentO(opAddr);
      if (o === null) continue;
      cells.push(o, valueForOp("i", opAddr + 1));
    } else if (b.op === "nop2") {
      const o1 = permanentO(opAddr);
      const o2 = permanentO(opAddr + 1);
      if (o1 === null || o2 === null) continue;
      cells.push(o1, o2, valueForOp("i", opAddr + 2));
    } else if (b.op === "v") {
      cells.push(valueForOp("v", opAddr), valueForOp("i", opAddr + 1));
    } else {
      const r = restorableValue(b.op, opAddr);
      if (r === null) continue;
      cells.push(r, valueForOp("i", opAddr + 1));
    }
    out.push({ entry, cells });
  }
  return out;
}

export interface AssembleOptions {
  /** Upper bound on addresses to try for tapes that are not MovD targets. */
  maxAddress?: number;
  /** Search budget for the placer. */
  maxSteps?: number;
  /** How many one-word filler blocks the packer may create on demand. */
  maxAutoJmpBlocks?: number;
  /** How many MovD splits the packer may insert into one segment. */
  maxSplitsPerSegment?: number;
  /** Receives diagnostic messages about the search. */
  trace?: (msg: string) => void;
}

export function assemble(program: Program, opts: AssembleOptions = {}): Assembled {
  const maxAddress = opts.maxAddress ?? 1_000_000;
  const blocks = new Map(program.blocks.map((b) => [b.label, b]));
  const nop2Block = program.blocks.find((b) => b.op === "nop2");
  const tapes = program.tapes.map((seg) => ({ segment: seg, visits: expandTape(seg, blocks) }));
  const entrySeg = tapes.find((t) => t.segment.label === program.entry);
  if (!entrySeg) throw new AssembleError(`entry segment ${program.entry} not found`);

  const occupied = new Set<number>();
  const symbols = new Map<string, number>();
  const placedBlocks: PlacedBlock[] = [];

  const resolve = (spec: WordSpec): number | null => {
    if (spec.kind === "const") return spec.value;
    if (spec.kind === "ref") {
      const a = symbols.get(spec.label);
      return a === undefined ? null : a + spec.offset;
    }
    return null;
  };
  /** true = legal, false = illegal, null = unknown (unplaced reference). */
  const wordOk = (spec: WordSpec, addr: number): boolean | null => {
    if (spec.kind === "junk") return true;
    const v = resolve(spec);
    return v === null ? null : isValidAt(v, addr);
  };
  const free = (from: number, len: number) => {
    for (let a = from; a < from + len; a++) if (occupied.has(a)) return false;
    return true;
  };

  let steps = 0;
  const budget = opts.maxSteps ?? 2_000_000;
  const jBlock = program.blocks.find((b) => b.op === "j");

  // Forward references to labels that are not bound yet: checked when bound.
  const pending: { addr: number; spec: WordSpec }[] = [];
  const checkPending = (label: string): boolean =>
    pending.every((p) => !(p.spec.kind === "ref" && p.spec.label === label) || wordOk(p.spec, p.addr) !== false);

  type Placed = { segment: TapeSegment; start: number; visits: XVisit[]; addrs: number[] };
  const placedTapes: Placed[] = [];
  const tapeOrder = [entrySeg, ...tapes.filter((t) => t !== entrySeg)];

  const placeBlocks = (i: number): boolean => {
    if (i === program.blocks.length) return placeSegment(0);
    const b = program.blocks[i];
    for (const cand of blockCandidates(b)) {
      if (++steps > budget) return false;
      const w = cand.cells.length;
      if (!free(cand.entry, w)) continue;
      for (let k = 0; k < w; k++) occupied.add(cand.entry + k);
      symbols.set(b.label, cand.entry);
      placedBlocks.push({ block: b, entry: cand.entry, cells: cand.cells });
      if (placeBlocks(i + 1)) return true;
      placedBlocks.pop();
      symbols.delete(b.label);
      for (let k = 0; k < w; k++) occupied.delete(cand.entry + k);
    }
    return false;
  };

  /** Occupy the cells of a visit at `a` (pointer word + operands). */
  // Junk operand words are never read, so they may overlap any other cell.
  const occupy = (v: XVisit, a: number, on: boolean) => {
    const toggle = (x: number) => (on ? occupied.add(x) : occupied.delete(x));
    toggle(a);
    v.operands.forEach((sp, k) => sp.kind !== "junk" && toggle(a + 1 + k));
  };
  const canPlace = (v: XVisit, a: number): boolean => {
    if (occupied.has(a)) return false;
    const p = symbols.get(v.block);
    if (p === undefined || !isValidAt(p, a)) return false;
    for (let k = 0; k < v.operands.length; k++) {
      const sp = v.operands[k];
      if (sp.kind === "junk") continue;
      if (occupied.has(a + 1 + k) || wordOk(sp, a + 1 + k) === false) return false;
    }
    return true;
  };
  const withPending = (v: XVisit, a: number, fn: () => boolean): boolean => {
    const added: number[] = [];
    v.operands.forEach((sp, k) => {
      if (sp.kind === "ref" && !symbols.has(sp.label)) {
        pending.push({ addr: a + 1 + k, spec: sp });
        added.push(pending.length - 1);
      }
    });
    const ok = fn();
    if (!ok) pending.splice(pending.length - added.length, added.length);
    return ok;
  };

  const nopBlocks = program.blocks.filter((b) => b.op === "nop");
  const jmpBlocks: CodeBlock[] = program.blocks.filter((b) => b.op === "jmp");
  const autoJmp: PlacedBlock[] = [];
  const maxAutoJmp = opts.maxAutoJmpBlocks ?? 24;
  const restorable = (label: string) => {
    const op = blocks.get(label)!.op;
    return op === "*" || op === "p" || op === "<" || op === "/" || op === "j";
  };

  const placeSegment = (si: number): boolean => {
    if (si === tapeOrder.length) return finalCheck();
    const t = tapeOrder[si];
    const isEntry = t === entrySeg;
    const lo = 2;
    const hi = t.segment.movdTarget ? 127 : maxAddress;
    const out: XVisit[] = [];
    const addrs: number[] = [];
    const n = t.visits.length;

    /**
     * Depth-first packing over the positions of real visits. The gap between
     * consecutive placed words is filled with one-word visits to jmp blocks,
     * which are created on demand (without backtracking over the choice of
     * block). `pendingRestore` holds blocks in their nop phase; a block cannot
     * be used again until its restore visit is placed, which may float
     * anywhere before that next use.
     */
    const MAX_GAP = 200;
    const maxSplits = opts.maxSplitsPerSegment ?? 2;
    // Failed states are memoized (heuristically: created filler blocks may
    // differ between paths, but a state that failed once almost always fails).
    let failed = new Set<string>();
    let deepest = { i: -1, a: 0 };
    const dfs = (i: number, a: number, pendingRestore: Set<string>, splits = 0): boolean => {
      if (++steps > budget) return false;
      const memoKey = `${i}|${a}|${[...pendingRestore].sort().join(",")}|${splits}`;
      if (failed.has(memoKey)) return false;
      const ok = dfsInner(i, a, pendingRestore, splits);
      if (!ok) failed.add(memoKey);
      return ok;
    };
    const dfsInner = (i: number, a: number, pendingRestore: Set<string>, splits: number): boolean => {
      if (i > deepest.i || (i === deepest.i && a > deepest.a)) deepest = { i, a };
      const needRestore = [...pendingRestore].filter((b) => !jBlock || b !== jBlock.label);
      if (i === n && needRestore.length === 0) {
        placedTapes.push({ segment: t.segment, start: addrs[0], visits: [...out], addrs: [...addrs] });
        if (placeSegment(si + 1)) return true;
        placedTapes.pop();
        return false;
      }
      const emitAt = (x: XVisit, b: number, next: () => boolean): boolean => {
        // Fill [a, b) with jmp fillers, then place x at b.
        const trail = fillGap(a, b, b + x.operands.length);
        if (!trail) return false;
        if (!canPlace(x, b)) {
          // a filler block created while filling the gap took these cells
          unfill(trail);
          return false;
        }
        occupy(x, b, true);
        out.push(x);
        addrs.push(b);
        if (x.label) symbols.set(x.label, b);
        const ok = withPending(x, b, next);
        if (ok) return true;
        if (x.label) symbols.delete(x.label);
        addrs.pop();
        out.pop();
        occupy(x, b, false);
        unfill(trail);
        return false;
      };
      const v = i < n ? t.visits[i] : null;
      for (let b = a; b <= a + MAX_GAP; b++) {
        if (occupied.has(b)) break; // cannot fill across an occupied cell
        // 1. Place the next real visit.
        if (v && !pendingRestore.has(v.block) && canPlace(v, b)) {
          const np = new Set(pendingRestore);
          if (restorable(v.block)) np.add(v.block);
          if (emitAt(v, b, () => dfs(i + 1, b + 1 + v.operands.length, np, splits))) return true;
        }
        // 2. Place a pending restore visit.
        for (const blk of pendingRestore) {
          const r: XVisit = { block: blk, operands: [junk()], inserted: true };
          if (!canPlace(r, b)) continue;
          const np = new Set(pendingRestore);
          np.delete(blk);
          if (emitAt(r, b, () => dfs(i, b + 2, np, splits))) return true;
        }
      }
      // 3. Split: MovD to another address (the target must be <= 127 as a pointer value).
      if (splits < maxSplits && jBlock && !pendingRestore.has(jBlock.label) && (v || needRestore.length)) {
        const p = symbols.get(jBlock.label)!;
        for (let b = a; b <= a + MAX_GAP; b++) {
          if (occupied.has(b)) break;
          if (occupied.has(b + 1) || !isValidAt(p, b)) continue;
          const np = new Set(pendingRestore);
          np.add(jBlock.label);
          for (let a2 = 2; a2 <= 127; a2++) {
            if (occupied.has(a2) || a2 === b || a2 === b + 1) continue;
            if (!isValidAt(a2 - 1, b + 1)) continue;
            const mv: XVisit = { block: jBlock.label, operands: [{ kind: "const", value: a2 - 1 }], inserted: true };
            if (emitAt(mv, b, () => dfs(i, a2, np, splits + 1))) return true;
            if (steps > budget) return false;
          }
        }
      }
      return false;
    };

    /** Fill cells [a, b) with one-word jmp visits; returns an undo trail or null. */
    type Trail = { visitsAdded: number; blocksAdded: PlacedBlock[] };
    const fillFail: string[] = [];
    const noteFill = (msg: string) => {
      if (opts.trace && fillFail.length < 12 && !fillFail.includes(msg)) fillFail.push(msg);
    };
    let tapeStart = 0;
    const fillGap = (a: number, b: number, reservedEnd: number): Trail | null => {
      const trail: Trail = { visitsAdded: 0, blocksAdded: [] };
      for (let c = a; c < b; c++) {
        if (occupied.has(c)) {
          const owner = [...symbols].filter(([, a]) => a <= c && c <= a + 3).map(([l]) => l).join("/");
          noteFill(`occ@${c}(${owner})`);
          unfill(trail);
          return null;
        }
        let blk = jmpBlocks.find((jb) => isValidAt(symbols.get(jb.label)!, c));
        if (!blk) {
          if (autoJmp.length >= maxAutoJmp) {
            noteFill(`cap@r${c % 94}`);
            unfill(trail);
            return null;
          }
          // Create a jmp block covering residue c; prefer the entry covering the
          // most residues that no existing block covers.
          let best: { e: number; score: number } | null = null;
          for (const s of [4, 5, 23, 39, 40, 62, 68, 81]) {
            let e = (((s - c) % 94) + 94) % 94;
            if (e < 33) e += 94;
            if (e > 126 || !free(e, 2)) continue;
            if (e + 1 >= c && e <= reservedEnd) continue; // must not overlap the gap or the visit
            // Prefer cells behind the tape start: the tape can never need them again.
            let score = e + 1 < tapeStart ? 100 : 0;
            for (const s2 of [4, 5, 23, 39, 40, 62, 68, 81]) {
              const r = (((s2 - e) % 94) + 94) % 94;
              if (!jmpBlocks.some((jb) => isValidAt(symbols.get(jb.label)!, r))) score++;
            }
            if (!best || score > best.score) best = { e, score };
          }
          if (!best) {
            noteFill(`nocand@r${c % 94}`);
            unfill(trail);
            return null;
          }
          const e = best.e;
          const label = `jmp@${e}`;
          const pb: PlacedBlock = { block: { label, op: "jmp" }, entry: e, cells: [fillerValue(e), valueForOp("i", e + 1)] };
          occupied.add(e);
          occupied.add(e + 1);
          symbols.set(label, e);
          placedBlocks.push(pb);
          autoJmp.push(pb);
          jmpBlocks.push(pb.block);
          trail.blocksAdded.push(pb);
          blk = pb.block;
          if (occupied.has(c)) {
            unfill(trail);
            return null;
          }
        }
        const jv: XVisit = { block: blk.label, operands: [], inserted: true };
        occupied.add(c);
        out.push(jv);
        addrs.push(c);
        trail.visitsAdded++;
      }
      return trail;
    };
    const unfill = (trail: Trail) => {
      for (let k = 0; k < trail.visitsAdded; k++) {
        const c = addrs.pop()!;
        out.pop();
        occupied.delete(c);
      }
      for (let k = trail.blocksAdded.length - 1; k >= 0; k--) {
        const pb = trail.blocksAdded[k];
        jmpBlocks.pop();
        autoJmp.pop();
        placedBlocks.pop();
        symbols.delete(pb.block.label);
        occupied.delete(pb.entry);
        occupied.delete(pb.entry + 1);
      }
    };

    const starts: number[] = [];
    if (isEntry) {
      // Entry: cell 0 '(' sets D := 40 (then 41); cell 1 is a j reading the
      // steering word at 41, so D := [41] + 1; cell 2 is a Jmp that reads the
      // first tape word at D. The steering word must be legal at 41.
      for (let v = 33; v <= 126; v++) if (isValidAt(v, 41)) starts.push(v + 1);
    } else {
      for (let a = lo; a <= hi; a++) starts.push(a);
    }
    for (const start of starts) {
      if (++steps > budget) return false;
      if (isEntry && (!free(0, 3) || (start !== 42 && occupied.has(41)))) continue;
      if (occupied.has(start)) continue;
      symbols.set(t.segment.label, start);
      if (!checkPending(t.segment.label)) {
        symbols.delete(t.segment.label);
        continue;
      }
      if (isEntry) for (const a of [0, 1, 2, 41]) occupied.add(a);
      const init = new Set<string>();
      if (t.segment.movdTarget && jBlock) init.add(jBlock.label);
      failed = new Set<string>(); // memo is only valid within one start attempt
      deepest = { i: -1, a: 0 };
      tapeStart = start;
      if (dfs(0, start, init)) return true;
      opts.trace?.(`segment ${t.segment.label} start ${start}: failed; deepest visit ${deepest.i}/${n} at ${deepest.a}; fill failures: ${fillFail.join(" ")}`);
      fillFail.length = 0;
      if (isEntry) for (const a of [0, 1, 2, 41]) occupied.delete(a);
      symbols.delete(t.segment.label);
    }
    return false;
  };

  const finalCheck = (): boolean => {
    for (const pt of placedTapes) {
      for (let idx = 0; idx < pt.visits.length; idx++) {
        const v = pt.visits[idx];
        const a = pt.addrs[idx];
        if (!isValidAt(symbols.get(v.block)!, a)) return false;
        for (let k = 0; k < v.operands.length; k++) if (wordOk(v.operands[k], a + 1 + k) !== true) return false;
      }
    }
    return true;
  };

  if (!placeBlocks(0)) throw new AssembleError(`could not place program (search steps: ${steps})`);

  // Build the image.
  let size = 0;
  for (const a of occupied) size = Math.max(size, a);
  const image = new Uint8Array(size + 1);
  const set = (a: number, v: number) => {
    if (!isValidAt(v, a)) throw new AssembleError(`internal: value ${v} invalid at ${a}`);
    image[a] = v;
  };
  const entryStart = placedTapes.find((p) => p.segment === entrySeg.segment)!.start;
  set(0, 40); // '(' : D := 40, then 41
  set(1, valueForOp("j", 1)); // D := [41] + 1
  set(2, valueForOp("i", 2)); // Jmp: C := [D], execution continues at [D] + 1
  set(41, entryStart - 1); // steering word
  for (const pb of placedBlocks) pb.cells.forEach((v, j) => set(pb.entry + j, v));
  const layout: Assembled["layout"] = [];
  for (const pt of placedTapes) {
    const words: { addr: number; value: number; note: string }[] = [];
    pt.visits.forEach((v, idx) => {
      const a = pt.addrs[idx];
      const p = symbols.get(v.block)!;
      set(a, p);
      words.push({ addr: a, value: p, note: `${v.inserted ? "+" : ""}${v.block}${v.label ? " @" + v.label : ""}` });
      v.operands.forEach((sp, kk) => {
        const aa = a + 1 + kk;
        const val = sp.kind === "junk" ? fillerValue(aa) : resolve(sp)!;
        set(aa, val);
        words.push({ addr: aa, value: val, note: sp.kind === "junk" ? "junk" : sp.kind === "const" ? "const" : `${sp.label}${sp.offset >= 0 ? "+" : ""}${sp.offset}` });
      });
    });
    layout.push({ label: pt.segment.label, start: pt.start, words });
  }
  for (let a = 0; a <= size; a++) if (!occupied.has(a)) set(a, fillerValue(a));
  return { source: String.fromCharCode(...image), image, symbols, size, layout };
}

/** Convenience for building visit lists. */
export function visit(block: string, operand: WordSpec = junk(), label?: string): Visit {
  return label ? { block, operand, label } : { block, operand };
}

export function describeLayout(asm: Assembled): string {
  const lines: string[] = [];
  for (const [label, addr] of [...asm.symbols].sort((x, y) => x[1] - y[1])) lines.push(`${String(addr).padStart(6)}  ${label}`);
  for (const seg of asm.layout) {
    lines.push(`-- tape ${seg.label} @${seg.start}`);
    for (const w of seg.words) lines.push(`${String(w.addr).padStart(6)}  ${String(w.value).padStart(3)} ${JSON.stringify(String.fromCharCode(w.value))}  ${w.note}`);
  }
  return lines.join("\n");
}
