/**
 * Assembler: places code blocks and tape segments in memory, chooses cell
 * values, and emits Malbolge source. See ir.ts for the execution model.
 *
 * Address constraints:
 * - A restorable block [entry][op][jmp] needs its op cell at a residue (mod 94)
 *   where the F/J two-cycle alternates op/nop. Its pointer value is the entry
 *   address, which must be a legal source char (33..126), so blocks live in
 *   [33, 126]. The double-j block is fixed at 59..65.
 * - Any tape segment that is a MovD target needs address <= 127 for the same
 *   reason (with the double-j block the pointer cell must be <= 130, the
 *   operand word being pointer cell - 4).
 * - Every cell of the source must decode to a real instruction at its address.
 *   The packer inserts one-word visits to jmp blocks (created on demand)
 *   between visits so that every fixed word lands on an address where it is
 *   legal, and splits tapes with MovDs when they run into occupied cells.
 */
import { fillerValue, isValidAt, permanentO, restorableValue, valueForOp } from "./cycles.js";
import { patchingEntryPlans, plainEntryPlans, type EntryPlan } from "./entry.js";
import { type BlockOp, type CodeBlock, type Program, type TapeSegment, type Visit, type WordSpec, junk } from "./ir.js";

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
  operands: WordSpec[];
  label?: string;
  inserted?: boolean;
}

const DJ_ENTRY = 59;

function expandTape(seg: TapeSegment, blocks: Map<string, CodeBlock>): XVisit[] {
  const out: XVisit[] = [];
  for (const v of seg.visits) {
    const b = blocks.get(v.block);
    if (!b) throw new AssembleError(`unknown block ${v.block} in segment ${seg.label}`);
    if (v.operand.kind === "movd" && b.op !== "dj") throw new AssembleError(`movd operand on non-dj block ${v.block}`);
    const operands = b.op === "nop2" ? [v.operand, junk()] : b.op === "jmp" ? [] : [v.operand];
    out.push(v.label ? { block: v.block, operands, label: v.label } : { block: v.block, operands });
  }
  return out;
}

function blockCandidates(b: CodeBlock): { entry: number; cells: number[] }[] {
  const out: { entry: number; cells: number[] }[] = [];
  if (b.op === "dj") {
    // Gap cells are filled in once the entry code is planned.
    return [{ entry: DJ_ENTRY, cells: [fillerValue(59), restorableValue("j", 60)!, 0, 0, 0, restorableValue("j", 64)!, valueForOp("i", 65)] }];
  }
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
  const tapes = program.tapes.map((seg) => ({ segment: seg, visits: expandTape(seg, blocks) }));
  const entrySeg = tapes.find((t) => t.segment.label === program.entry);
  if (!entrySeg) throw new AssembleError(`entry segment ${program.entry} not found`);
  const djBlock = program.blocks.find((b) => b.op === "dj");
  const jBlock = program.blocks.find((b) => b.op === "j");
  if (djBlock && jBlock) throw new AssembleError("a program cannot have both a j block and a dj block");
  if (djBlock && program.blocks.some((b) => b.op === "*")) {
    throw new AssembleError("the rotation block overlaps the double-j block; use a separate initialization phase");
  }
  const movdBlock = djBlock ?? jBlock;

  const occupied = new Set<number>();
  const symbols = new Map<string, number>();
  // Reserve fixed landing addresses up front so blocks, scratch cells and
  // fillers stay off them; the reservation is lifted when the segment is placed.
  const fixedStarts = new Set(program.tapes.filter((t) => t.fixedStart !== undefined).map((t) => t.fixedStart!));
  for (const a of fixedStarts) occupied.add(a);
  const placedBlocks: PlacedBlock[] = [];
  /** Static pointer cells allocated for movd operands: address -> spec. */
  const pointerCells = new Map<number, WordSpec>();
  let entryPlan: EntryPlan | null = null;

  const resolve = (spec: WordSpec): number | null => {
    if (spec.kind === "const") return spec.value;
    if (spec.kind === "ref" || spec.kind === "movd") {
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

  // Forward references to labels that are not bound yet: checked when bound.
  const pending: { addr: number; spec: WordSpec }[] = [];
  const checkPending = (label: string): boolean =>
    pending.every((p) => !((p.spec.kind === "ref" || p.spec.kind === "movd") && p.spec.label === label) || wordOk(p.spec, p.addr) !== false);

  type Placed = { segment: TapeSegment; start: number; visits: XVisit[]; addrs: number[] };
  const placedTapes: Placed[] = [];
  const tapeOrder = [entrySeg, ...tapes.filter((t) => t !== entrySeg)];

  const placeBlocks = (i: number): boolean => {
    if (i === program.blocks.length) return placeEntry();
    const b = program.blocks[i];
    const cands = blockCandidates(b).filter((c) => b.address === undefined || c.entry === b.address);
    if (cands.length === 0) throw new AssembleError(`no legal placement for block ${b.label}${b.address === undefined ? "" : ` at ${b.address}`}`);
    const unconstrained = b.op === "v" || b.op === "jmp";
    let tried = 0;
    for (const cand of cands) {
      if (++steps > budget) return false;
      if (unconstrained && tried >= 4) break;
      const w = cand.cells.length;
      if (!free(cand.entry, w)) continue;
      tried++;
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

  /** Choose the entry code, then place the entry tape at its start. */
  const planCache = new Map<string, EntryPlan[]>();
  const placeEntry = (): boolean => {
    const isFree = (a: number) => !occupied.has(a);
    // Plans depend only on which low cells are free.
    let key = "";
    for (let a = 0; a <= 130; a++) key += occupied.has(a) ? "1" : "0";
    let plans = planCache.get(key);
    if (!plans) {
      const all = djBlock ? patchingEntryPlans(isFree) : plainEntryPlans(isFree);
      // One plan per start address is enough.
      const seen = new Set<number>();
      plans = all.filter((p) => (seen.has(p.start) ? false : (seen.add(p.start), true)));
      planCache.set(key, plans);
    }
    if (plans.length === 0) return false;
    for (const plan of plans) {
      if (++steps > budget) return false;
      const cells = [...plan.code.map((_, i) => i), ...plan.scratch.keys()];
      if (!plan.scratch.has(plan.steer.addr) && plan.steer.addr !== 64 && plan.steer.addr !== 65) cells.push(plan.steer.addr);
      if (!cells.every(isFree) || occupied.has(plan.start)) continue;
      cells.forEach((a) => occupied.add(a));
      entryPlan = plan;
      if (placeSegment(0, plan.start)) return true;
      entryPlan = null;
      cells.forEach((a) => occupied.delete(a));
    }
    return false;
  };

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
      if (occupied.has(a + 1 + k)) return false;
      if (sp.kind === "movd") continue; // resolved when placed
      if (wordOk(sp, a + 1 + k) === false) return false;
    }
    return true;
  };
  const withPending = (specs: { addr: number; spec: WordSpec }[], fn: () => boolean): boolean => {
    const before = pending.length;
    for (const s of specs) {
      if ((s.spec.kind === "ref" || s.spec.kind === "movd") && !symbols.has(s.spec.label)) pending.push(s);
    }
    const ok = fn();
    if (!ok) pending.length = before;
    return ok;
  };

  const restoreWidth = (label: string) => (blocks.get(label)!.op === "dj" ? 5 : 1);
  const restorable = (label: string) => {
    const op = blocks.get(label)!.op;
    return op === "*" || op === "p" || op === "<" || op === "/" || op === "j" || op === "dj";
  };

  const jmpBlocks: CodeBlock[] = program.blocks.filter((b) => b.op === "jmp");
  const autoJmp: PlacedBlock[] = [];
  const maxAutoJmp = opts.maxAutoJmpBlocks ?? 24;

  const placeSegment = (si: number, forcedStart?: number): boolean => {
    if (si === tapeOrder.length) return finalCheck();
    const t = tapeOrder[si];
    const isEntry = t === entrySeg;
    const hi = t.segment.movdTarget ? (djBlock ? 131 : 127) : maxAddress;
    const out: XVisit[] = [];
    const addrs: number[] = [];
    const n = t.visits.length;
    const maxSplits = opts.maxSplitsPerSegment ?? 2;
    const MAX_GAP = 200;
    let failed = new Set<string>();
    let deepest = { i: -1, a: 0 };
    let tapeStart = 0;

    const dfs = (i: number, a: number, pendingRestore: Set<string>, splits = 0): boolean => {
      if (++steps > budget) return false;
      const memoKey = `${i}|${a}|${[...pendingRestore].sort().join(",")}|${splits}`;
      if (failed.has(memoKey)) return false;
      const ok = dfsInner(i, a, pendingRestore, splits);
      if (!ok) failed.add(memoKey);
      return ok;
    };

    /**
     * Allocate a static pointer cell for a movd operand placed at `b + 1`:
     * the cell holds target + offset, the operand word holds cell - 4.
     */
    const allocPointerCell = (spec: WordSpec & { kind: "movd" }, operandAddr: number): number | null => {
      const target = resolve(spec);
      for (let c = 37; c <= 130; c++) {
        if (occupied.has(c) || c === operandAddr || c === operandAddr - 1) continue;
        if (!isValidAt(c - 4, operandAddr)) continue;
        if (target !== null && !isValidAt(target, c)) continue;
        return c;
      }
      return null;
    };

    const dfsInner = (i: number, a: number, pendingRestore: Set<string>, splits: number): boolean => {
      if (i > deepest.i || (i === deepest.i && a > deepest.a)) deepest = { i, a };
      const needRestore = [...pendingRestore].filter((b) => !movdBlock || b !== movdBlock.label);
      if (i === n && needRestore.length === 0) {
        placedTapes.push({ segment: t.segment, start: addrs[0], visits: [...out], addrs: [...addrs] });
        if (placeSegment(si + 1)) return true;
        placedTapes.pop();
        return false;
      }
      const emitAt = (x: XVisit, b: number, next: () => boolean): boolean => {
        const trail = fillGap(a, b, b + x.operands.length);
        if (!trail) return false;
        if (!canPlace(x, b)) {
          unfill(trail);
          return false;
        }
        // Resolve movd operands into pointer cells.
        const cellsAllocated: number[] = [];
        const specs: { addr: number; spec: WordSpec }[] = [];
        const operands = x.operands.map((sp, k) => {
          const at = b + 1 + k;
          if (sp.kind !== "movd") {
            specs.push({ addr: at, spec: sp });
            return sp;
          }
          const c = allocPointerCell(sp, at);
          if (c === null) return null;
          occupied.add(c);
          cellsAllocated.push(c);
          pointerCells.set(c, sp);
          specs.push({ addr: c, spec: sp });
          return { kind: "const", value: c - 4 } as WordSpec;
        });
        const undoCells = () => {
          for (const c of cellsAllocated) {
            occupied.delete(c);
            pointerCells.delete(c);
          }
        };
        if (operands.some((o) => o === null)) {
          undoCells();
          unfill(trail);
          return false;
        }
        const placed: XVisit = { ...x, operands: operands as WordSpec[] };
        occupy(placed, b, true);
        out.push(placed);
        addrs.push(b);
        if (x.label) symbols.set(x.label, b);
        const ok = withPending(specs, next);
        if (ok) return true;
        if (x.label) symbols.delete(x.label);
        addrs.pop();
        out.pop();
        occupy(placed, b, false);
        undoCells();
        unfill(trail);
        return false;
      };
      const v = i < n ? t.visits[i] : null;
      for (let b = a; b <= a + MAX_GAP; b++) {
        if (occupied.has(b)) break; // cannot fill across an occupied cell
        // 1. Place the next real visit. A MovD use transfers control, so every
        //    other pending restore must already be in place before it.
        const isMovdUse = v !== null && movdBlock !== undefined && v.block === movdBlock.label;
        if (v && !pendingRestore.has(v.block) && !(isMovdUse && needRestore.length > 0) && canPlace(v, b)) {
          const np = new Set(pendingRestore);
          if (restorable(v.block)) np.add(v.block);
          if (emitAt(v, b, () => dfs(i + 1, b + 1 + v.operands.length, np, splits))) return true;
        }
        // 2. Place a pending restore visit.
        for (const blk of pendingRestore) {
          const r: XVisit = { block: blk, operands: Array.from({ length: restoreWidth(blk) }, () => junk()), inserted: true };
          if (!canPlace(r, b)) continue;
          const np = new Set(pendingRestore);
          np.delete(blk);
          if (emitAt(r, b, () => dfs(i, b + 1 + r.operands.length, np, splits))) return true;
        }
      }
      // 3. Split: MovD to another address (the target must be pointer-addressable).
      if (splits < maxSplits && movdBlock && !pendingRestore.has(movdBlock.label) && (v || needRestore.length)) {
        const p = symbols.get(movdBlock.label)!;
        for (let b = a; b <= a + MAX_GAP; b++) {
          if (occupied.has(b)) break;
          if (occupied.has(b + 1) || !isValidAt(p, b)) continue;
          const np = new Set(pendingRestore);
          np.add(movdBlock.label);
          for (let a2 = 2; a2 <= (djBlock ? 131 : 127); a2++) {
            if (occupied.has(a2) || a2 === b || a2 === b + 1) continue;
            let mv: XVisit;
            if (djBlock) {
              const c = allocPointerCellFor(a2 - 1, b + 1);
              if (c === null) continue;
              mv = { block: movdBlock.label, operands: [{ kind: "const", value: a2 - 1 } as WordSpec], inserted: true };
              // encode as a movd to a synthetic label so the pointer cell is allocated uniformly
              const label = `split@${b}`;
              symbols.set(label, a2);
              mv = { block: movdBlock.label, operands: [{ kind: "movd", label, offset: -1 }], inserted: true };
              const ok = emitAt(mv, b, () => dfs(i, a2, np, splits + 1));
              if (ok) return true;
              symbols.delete(label);
            } else {
              if (!isValidAt(a2 - 1, b + 1)) continue;
              mv = { block: movdBlock.label, operands: [{ kind: "const", value: a2 - 1 }], inserted: true };
              if (emitAt(mv, b, () => dfs(i, a2, np, splits + 1))) return true;
            }
            if (steps > budget) return false;
          }
        }
      }
      return false;
    };
    const allocPointerCellFor = (value: number, operandAddr: number): number | null => {
      for (let c = 37; c <= 130; c++) {
        if (occupied.has(c) || c === operandAddr || c === operandAddr - 1) continue;
        if (!isValidAt(c - 4, operandAddr) || !isValidAt(value, c)) continue;
        return c;
      }
      return null;
    };

    /** Fill cells [a, b) with one-word jmp visits; returns an undo trail or null. */
    type Trail = { visitsAdded: number; blocksAdded: PlacedBlock[] };
    const fillFail: string[] = [];
    const noteFill = (msg: string) => {
      if (opts.trace && fillFail.length < 12 && !fillFail.includes(msg)) fillFail.push(msg);
    };
    const fillGap = (a: number, b: number, reservedEnd: number): Trail | null => {
      const trail: Trail = { visitsAdded: 0, blocksAdded: [] };
      for (let c = a; c < b; c++) {
        if (occupied.has(c)) {
          noteFill(`occ@${c}`);
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
          let best: { e: number; score: number } | null = null;
          for (const s of [4, 5, 23, 39, 40, 62, 68, 81]) {
            let e = (((s - c) % 94) + 94) % 94;
            if (e < 33) e += 94;
            if (e > 126 || !free(e, 2)) continue;
            if (e + 1 >= c && e <= reservedEnd) continue; // must not overlap the gap or the visit
            let score = e + 1 < tapeStart ? 100 : 0; // prefer cells behind the tape start
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

    let starts: number[];
    if (forcedStart !== undefined) starts = [forcedStart];
    else if (t.segment.fixedStart !== undefined) starts = [t.segment.fixedStart];
    else {
      starts = [];
      for (let a = 2; a <= hi; a++) starts.push(a);
    }
    for (const start of starts) {
      if (++steps > budget) return false;
      const reserved = t.segment.fixedStart === start && fixedStarts.has(start);
      if (reserved) occupied.delete(start);
      if (occupied.has(start)) {
        if (reserved) occupied.add(start);
        continue;
      }
      symbols.set(t.segment.label, start);
      if (!checkPending(t.segment.label)) {
        symbols.delete(t.segment.label);
        if (reserved) occupied.add(start);
        continue;
      }
      const init = new Set<string>();
      if (t.segment.movdTarget && movdBlock) init.add(movdBlock.label);
      failed = new Set<string>();
      deepest = { i: -1, a: 0 };
      tapeStart = start;
      if (dfs(0, start, init)) return true;
      opts.trace?.(`segment ${t.segment.label} start ${start}: failed; deepest visit ${deepest.i}/${n} at ${deepest.a}; fill failures: ${fillFail.join(" ")}`);
      fillFail.length = 0;
      symbols.delete(t.segment.label);
      if (reserved) occupied.add(start);
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
    for (const [c, spec] of pointerCells) if (wordOk(spec, c) !== true) return false;
    return true;
  };

  if (!placeBlocks(0)) throw new AssembleError(`could not place program (search steps: ${steps})`);
  const plan = entryPlan!;

  // Build the image.
  let size = 0;
  for (const a of occupied) size = Math.max(size, a);
  const image = new Uint8Array(size + 1);
  const set = (a: number, v: number) => {
    if (!isValidAt(v, a)) throw new AssembleError(`internal: value ${v} invalid at ${a}`);
    image[a] = v;
  };
  plan.code.forEach((v, a) => set(a, v));
  for (const [a, v] of plan.scratch) set(a, v);
  if (plan.steer.addr !== 64 && plan.steer.addr !== 65) set(plan.steer.addr, plan.steer.value);
  for (const pb of placedBlocks) {
    const cells = pb.block.op === "dj" ? [pb.cells[0], pb.cells[1], ...plan.gap!, pb.cells[5], pb.cells[6]] : pb.cells;
    cells.forEach((v, j) => set(pb.entry + j, v));
  }
  for (const [c, spec] of pointerCells) set(c, resolve(spec)!);
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
        const val = sp.kind === "junk" ? (image[aa] || fillerValue(aa)) : resolve(sp)!;
        if (sp.kind !== "junk") set(aa, val);
        words.push({ addr: aa, value: val, note: sp.kind === "junk" ? "junk" : sp.kind === "const" ? "const" : `${sp.label}${sp.offset >= 0 ? "+" : ""}${sp.offset}` });
      });
    });
    layout.push({ label: pt.segment.label, start: pt.start, words });
  }
  for (let a = 0; a <= size; a++) if (!occupied.has(a) && image[a] === 0) set(a, fillerValue(a));
  for (const [c] of pointerCells) symbols.set(`ptrcell@${c}`, c);
  symbols.set(`steer@${plan.steer.addr}`, plan.steer.addr);
  symbols.set("entrycode-end", plan.code.length - 1);
  for (const [a] of plan.scratch) symbols.set(`scratch@${a}`, a);
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

export type { BlockOp };
