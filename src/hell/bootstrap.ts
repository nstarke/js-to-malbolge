/** Input-free installation in banks whose addresses are discovered on the target. */
import { fromNumber, type Trits } from "../malbolge/trits.js";
import { encryptValue, fillerValue, isValidAt, permanentNopValues, restorableValue, valueForOp, type Op } from "./cycles.js";

export interface BankWord { bank: number; offset: number }
export interface BootstrapPatch { at: BankWord; value: BankWord | Trits }
type Patch = BootstrapPatch;
interface Native { op: "*" | "p"; register: string }
export interface BootstrapImage {
  source: string;
  /** Read this low register and divide its finite value by two to resolve banks. */
  basisRegister: number;
  symbols: Map<string, BankWord>;
  codeCells: number;
  /** payload finishes as 2 * 3^shift, without knowing the physical width. */
  shift: number;
  statistics: { sourceCells: number; phases: Record<string, number>; patches: number; generatedPaddingCells: number; installer: "unrolled" | "loop" };
}
export interface BootstrapInstaller {
  patches: BootstrapPatch[];
  entry: BankWord;
  next: BankWord;
  resume: BankWord;
  fill: { bank: number; start: number; end: number; value: Trits };
}

const NOPS = Array.from({ length: 94 }, (_, r) => permanentNopValues(r).filter((v) => v <= 80));
const ONE = 67, TWO = 34, MAXLOW = 54, ADDRESS = 96, MAX = 71;
const HIGH = [44, 46, 56, 58, 65, 69];
const LOW = [TWO, 75, 73, 63];
const WORK = [85, 87, 89], READMASK = 91, COPY = 93;
const RETURNS = [43, 60, 79, 95, 118, 124];
const DISPATCH = new Map([[34, 48], [67, 51], [96, 39], [114, 62]]);
const key = (a: BankWord) => `${a.bank}:${a.offset}`;

export function bootstrapCycleImage(entry = 5, sourceReturn = false): { patches: Patch[]; symbols: Map<string, BankWord>; codeCells: number } {
  const body: Native[] = [];
  const constants: Record<string, Trits> = {};
  const emit = (op: Native["op"], register: string, n = 1) => {
    if (register === "one" || register === "six") {
      const value = register === "one" ? "1" : fromNumber(6);
      register = `${register}.${body.length}`; constants[register] = value;
    }
    for (let i = 0; i < n; i++) body.push({ op, register });
  };
  // Restore the state left by a nonterminal iteration, then test the marker.
  emit("*", "one"); emit("p", "test", 3);
  emit("*", "one"); emit("p", "z0"); emit("*", "one"); emit("p", "z1");
  emit("*", "one"); emit("p", "six"); emit("p", "d6"); emit("*", "one"); emit("p", "d6");
  emit("p", "z0"); emit("p", "d3"); emit("*", "one"); emit("p", "z0");
  if (sourceReturn) emit("*", "sourceReturn");
  emit("*", "payload"); emit("*", "marker"); emit("p", "test");
  emit("*", "one"); emit("p", "six"); emit("p", "test");
  emit("p", "d6"); emit("p", "d3"); emit("p", "z0"); emit("p", "z1");
  emit("p", "next"); emit("*", "tail");
  const initial: Record<string, Trits> = { test: "121", z0: fromNumber(3), z1: "101",
    d6: fromNumber(3), d3: "101", marker: fromNumber(3), payload: fromNumber(2), tail: "0", ...(sourceReturn ? { sourceReturn: fromNumber(2) } : {}), ...constants };
  const symbols = new Map(Object.keys(initial).map((name, i) => [name, { bank: i + 1, offset: 80 }]));
  symbols.set("next", { bank: 200, offset: 80 });
  const patches: Patch[] = [];
  const occupied = new Set<string>();
  const patchValues = new Map<string, string>();
  const patch = (at: BankWord, value: BankWord | Trits) => {
    const valueKey = typeof value === "string" ? value : key(value);
    if (patchValues.get(key(at)) === valueKey) return;
    if (occupied.has(key(at))) throw new Error(`bootstrap layout collision ${key(at)}`);
    occupied.add(key(at)); patchValues.set(key(at), valueKey); patches.push({ at, value });
  };
  const code = new Map<number, number>();
  const codeBank = 188, start = entry + 1;
  code.set(entry - 3, 74); code.set(entry - 2, valueForOp("v", entry - 2)); code.set(entry, 74);
  if (sourceReturn && start % 94 === 60) code.set(start, NOPS[start % 94][0]);
  let c = start + (sourceReturn && start % 94 === 60 ? 1 : 0), previous: { c: number; register: string } | undefined;
  let first: BankWord | undefined, firstJ = 60;
  for (const inst of body) {
    let j = c, p = 0;
    const dest = symbols.get(inst.register)!;
    let pointer: BankWord;
    const candidate = () => {
      for (;;) {
        while (restorableValue("j", j) === null) j++;
        p = j + 1; while (restorableValue(inst.op, p) === null) p++;
        pointer = { bank: dest.bank, offset: dest.offset - (p - j) };
        if (pointer.offset >= 0 && pointer.offset <= 80) return;
        j++;
      }
    };
    candidate();
    if (previous) {
      const prev = symbols.get(previous.register)!;
      while (occupied.has(key({ bank: prev.bank, offset: prev.offset + j - previous.c })) &&
        patchValues.get(key({ bank: prev.bank, offset: prev.offset + j - previous.c })) !== key(pointer!)) { j++; candidate(); }
      patch({ bank: prev.bank, offset: prev.offset + j - previous.c }, pointer!);
    } else { first = pointer!; firstJ = j; }
    for (; c < p; c++) code.set(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]);
    code.set(j, restorableValue("j", j)!); code.set(p, restorableValue(inst.op, p)!);
    previous = { c: p, register: inst.register }; c = p + 1;
  }
  const last = previous!;
  while (c % 94 !== 60) { code.set(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]); c++; }
  const restoreJ = c;
  // This j starts in its nop phase and runs only on the restoration pass.
  code.set(c, encryptValue(restorableValue("j", c)!)); c++;
  code.set(c, valueForOp("i", c));
  const tail = symbols.get("tail")!, next = symbols.get("next")!;
  const restorePointer = tail.offset + c - last.c;
  patch({ bank: tail.bank, offset: restorePointer }, { bank: codeBank, offset: entry });
  patch({ bank: tail.bank, offset: restorePointer + 1 + restoreJ - start }, { bank: next.bank, offset: next.offset - 1 });
  patch({ bank: next.bank, offset: next.offset + 1 + firstJ - start }, first!);
  for (const [offset, value] of code) patch({ bank: codeBank, offset }, fromNumber(value));
  for (const [name, value] of Object.entries(initial)) patch(symbols.get(name)!, value);
  patch(next, { bank: codeBank, offset: entry });
  if (sourceReturn) {
    const ret = symbols.get("sourceReturn")!;
    const halt = patches.find((p) => p.at.bank === codeBank && p.at.offset === entry - 2)!;
    halt.value = fromNumber(valueForOp("j", entry - 2));
    patch({ bank: codeBank, offset: entry - 1 }, fromNumber(valueForOp("i", entry - 1)));
    patch({ bank: next.bank, offset: next.offset + 1 }, { bank: ret.bank, offset: ret.offset - 1 });
    patch({ bank: ret.bank, offset: ret.offset + 1 }, fromNumber(38));
  }
  return { patches, symbols, codeCells: c + 1 };
}

/**
 * Install and execute a rotation-cycle bootstrap using legal source only.
 * Requires conforming Unshackled growth (initial width >=10, grow >=2*D width).
 * No input, host memory injection, guessed rotation count, or fixed-width policy.
 */
export function assembleBootstrap(shift = 20, maxSourceCells = 64_000_000): BootstrapImage {
  return installBootstrap(bootstrapCycleImage(), shift, maxSourceCells);
}

/** Internal linker entry: all patch values must fit the seed windows. */
export function installBootstrap(image: ReturnType<typeof bootstrapCycleImage>, shift: number, maxSourceCells: number, widenings = 2, application?: { patches: Patch[]; entry: BankWord; next: BankWord }, options: { installer?: BootstrapInstaller; compact?: boolean } = {}): BootstrapImage {
  if (!Number.isInteger(shift) || shift < 0 || shift > 30) throw new RangeError("bootstrap shift must be an integer from 0 through 30");
  if (!Number.isSafeInteger(maxSourceCells) || maxSourceCells < 1000 || maxSourceCells > 500_000_000) throw new RangeError("invalid bootstrap source budget");
  let phase = "calibration";
  const phases: Record<string, number> = {};
  let patchCount = 0;
  const blocks: Uint8Array[] = [];
  let block = new Uint8Array(32768), used = 0, c = 0;
  let installing = "";
  const byte = (v: number) => {
    if (c >= maxSourceCells) throw new RangeError(`bootstrap exceeds the source cell budget${installing}`);
    if (used === block.length) { blocks.push(block); block = new Uint8Array(32768); used = 0; }
    block[used++] = v; c++; phases[phase] = (phases[phase] ?? 0) + 1;
  };
  const header = new Uint8Array(127);
  for (let i = 0; i < header.length; i++) header[i] = fillerValue(i);
  const set = (addr: number, v: number) => { if (!isValidAt(v, addr)) throw new Error(`invalid bootstrap header ${addr}:${v}`); header[addr] = v; };
  set(0, 98); set(1, 38); set(99, valueForOp("j", 99)); set(110, valueForOp("i", 110));
  for (let i = 100; i < 110; i++) set(i, valueForOp("o", i));
  for (const r of RETURNS) set(r, 38);
  for (const [r, slot] of DISPATCH) set(slot, r - 1);
  set(34, 83); set(49, 126); set(67, 108); set(54, 80); set(63, 54);
  for (const v of header) byte(v);
  const raw = (op: Op) => byte(valueForOp(op, c));
  const nops = (n: number): Op[] => Array<Op>(n).fill("o");
  for (let i = 0; i < 10; i++) raw("o"); raw("j");
  const reserved = new Set<number>();
  for (let p = 81; 94 * p + 3 < maxSourceCells; p *= 3) reserved.add(94 * p + 3);
  const chunk = (ops: Op[]) => {
    // Every potential widening-return source cell is o=65, before execution,
    // or encrypted o=59 afterwards. Both return routes merge in the low bank.
    let collision = [...reserved].find((a) => a >= c && a < c + ops.length);
    while (collision !== undefined) {
      while (c <= collision) {
        const size = reserved.has(c + 4) ? 22 : 5;
        for (let i = 1; i < size; i++) raw("o"); raw("j");
      }
      collision = [...reserved].find((a) => a >= c && a < c + ops.length);
    }
    for (const op of ops) raw(op);
  };
  const select = (r: number): Op[] => {
    const slot = DISPATCH.get(r);
    return slot !== undefined ? [...nops(slot - 39), "j"] : nops(r - 39);
  };
  const op = (r: number, instruction: "p" | "*", count = 1) => {
    const ret = RETURNS.find((x) => x > r);
    if (ret === undefined) throw new Error(`no bootstrap return after ${r}`);
    for (let i = 0; i < count; i++) chunk([...select(r), instruction, ...nops(ret - r - 1), "j"]);
  };
  const ones = () => op(ONE, "*");
  const reset = (r: number, zero = false) => { ones(); op(r, "p", zero ? 3 : 2); };
  const read02 = (r: number) => { ones(); op(r, "p"); };
  const copy02 = (dest: number, src: number) => {
    if (dest === src) return;
    reset(dest); reset(COPY); read02(src); op(COPY, "p"); op(dest, "p");
  };
  const union = (dest: number, a: number, b: number) => {
    const permute = (out: number, x: number, y: number) => {
      reset(out); reset(77); reset(83); read02(y); op(77, "p"); op(83, "p");
      read02(x); op(83, "p"); op(out, "p");
    };
    permute(49, a, b); permute(114, b, a); op(49, "p"); ones(); op(49, "p"); copy02(dest, 49);
  };
  op(ONE, "p"); op(TWO, "p"); reset(ADDRESS); // Visit width-5 D before rotating seeds.
  copy02(73, 63); op(73, "*"); copy02(75, 73); op(75, "*");
  const seed = () => {
    for (let i = 0; i < HIGH.length; i++) { copy02(HIGH[i], TWO); op(HIGH[i], "*", i + 1); }
    union(MAX, HIGH[0], HIGH[1]);
    for (let i = 2; i < HIGH.length; i++) union(MAX, MAX, HIGH[i]);
    union(MAX, MAX, MAXLOW);
  };
  const read = (r: number, repeating = false) => {
    for (let i = 0; i < 2; i++) {
      if (!repeating) reset(READMASK);
      read02(MAX);
      if (!repeating) op(READMASK, "p");
      op(r, "p");
    }
  };
  const copy = (dest: number, src: number, repeating = false) => {
    if (dest === src) return;
    reset(dest); reset(COPY); read(src, repeating); op(COPY, "p"); op(dest, "p");
  };
  let wide = false;
  const lowSeeds = new Map<number, number>();
  const build = (word: BankWord | Trits): number => {
    if (word === "1") return ONE;
    let hi = 0, lo = 0, repeating = false;
    if (typeof word === "string") {
      repeating = word.at(-1) === "1";
      for (let i = 0; i < (wide ? 31 : 4); i++) {
        const t = Number(word[Math.min(i, word.length - 1)]);
        lo += (repeating && t !== 2 ? 1 - t : t) * 3 ** i;
      }
      if (word.length > (wide ? 32 : 5)) throw new RangeError("bootstrap literal exceeds the small seed window");
    } else { hi = word.bank; lo = word.offset; }
    if (!Number.isInteger(hi) || hi < 0 || hi > 728 || !Number.isInteger(lo) || lo < 0 || lo >= (wide ? 3 ** 31 : 81)) throw new RangeError("word outside bootstrap seed mask");
    let current = WORK[0]; reset(current, true);
    const digits: [number, number][] = [];
    for (let i = 0; i < (wide ? 31 : 4); i++) { digits.push([lo % 3, wide && i >= LOW.length ? lowSeeds.get(i) ?? -i - 1 : LOW[i]]); lo = Math.floor(lo / 3); }
    for (let i = 0; i < 6; i++) { digits.push([hi % 3, HIGH[5 - i]]); hi = Math.floor(hi / 3); }
    for (const [digit, seedMask] of digits) {
      if (!digit) continue;
      const mask = seedMask < 0 ? 116 : seedMask;
      if (seedMask < 0) { copy02(116, 111); op(116, "*", 31 + seedMask); }
      const [a, b] = WORK.filter((r) => r !== current);
      reset(a); reset(b);
      if (digit === 1) { read02(mask); op(a, "p"); }
      read02(mask); op(b, "p"); read(current); op(a, "p"); op(b, "p"); current = b;
    }
    if (repeating) { const dest = WORK.find((r) => r !== current)!; reset(dest); read(current); op(dest, "p"); current = dest; }
    return current;
  };
  // Each widening uses a seed produced at the current width, then returns
  // through a source/fill word without a rotation at the new width.
  for (let i = 0; i < widenings; i++) {
    seed(); copy(ADDRESS, build({ bank: 94, offset: 1 }));
    chunk(["j", "j", "o", "j", ...nops(58), "j"]);
  }
  seed(); // Width is now >=34, so final runtime banks lie beyond the source.
  const cache = new Map<Trits, number>();
  const preimages = new Set<Trits>();
  const cacheKey = (value: BankWord | Trits) => typeof value === "string" ? value : `@${key(value)}`;
  const counts = new Map<Trits, number>();
  for (const p of image.patches) if (typeof p.value === "string" && p.value !== "1") counts.set(p.value, (counts.get(p.value) ?? 0) + 1);
  const slots = [111, 116, 119, 121];
  for (const [word] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, slots.length)) {
    const slot = slots.shift()!, value = build(word);
    reset(slot); read(value, word.at(-1) === "1"); op(slot, "p");
    cache.set(word, slot); preimages.add(word);
  }
  const written = new Set<string>();
  let filled: BootstrapInstaller["fill"] | undefined;
  const replaced = new Map<string, BankWord | Trits>();
  const fillMasks: number[] = [];
  const isFilled = (at: BankWord) => filled && at.bank === filled.bank && at.offset >= filled.start && at.offset < filled.end;
  const existing = (at: BankWord) => replaced.get(key(at)) ?? (isFilled(at) ? filled!.value : undefined);
  let addressKey = "";
  let addressAnchor: BankWord | undefined;
  const address = (at: BankWord) => {
    // Dense code favors short walks. Sparse frames favor reusing a base over
    // a wider interval, so addresses are encoded as small forward deltas.
    const window = at.bank % 94 === 0 ? 128 : 512;
    const reuse = wide && addressKey && addressAnchor?.bank === at.bank && at.offset > addressAnchor.offset && at.offset - addressAnchor.offset <= window;
    const anchor = reuse ? addressAnchor! : { bank: at.bank, offset: wide ? at.offset - 1 : Math.min(79, at.offset - 1) };
    if (anchor.offset < 0) throw new RangeError("bootstrap bank offset zero is not writable");
    if (key(anchor) !== addressKey) { copy(ADDRESS, build(anchor)); addressKey = key(anchor); addressAnchor = anchor; }
    return anchor.offset;
  };
  const high = (at: BankWord, instruction: "p" | "*", anchor: number) => {
    let ret = at.offset + 1;
    let lowReturn = 65;
    for (;;) {
      const slot = { bank: at.bank, offset: ret }, value = existing(slot);
      if (value === fromNumber(74)) { lowReturn = 74; break; }
      if (value === undefined && (3 * (at.bank % 2) + ret) % 6 === 3 && !written.has(key(slot))) break;
      ret++;
    }
    const returnRegister = 79;
    chunk(["j", "j", ...nops(at.offset - anchor - 1), instruction, ...nops(ret - at.offset - 1), "j", ...nops(returnRegister - lowReturn - 1), "j"]);
  };
  const prepareTarget = (at: BankWord, anchor: number) => {
    if (fillMasks.length && at.bank !== 0 && !written.has(key(at)) && !isFilled(at)) {
      read02(fillMasks[(3 * (at.bank % 2) + at.offset) % 6]); high(at, "p", anchor);
    } else { ones(); high(at, "p", anchor); high(at, "p", anchor); }
  };
  const install = (patches: Patch[]) => {
    const savedPhase = phase;
    for (const patch of [...patches].sort((a, b) => a.at.bank - b.at.bank || a.at.offset - b.at.offset)) {
      phase = savedPhase === "application" ? patch.at.bank === 564 ? "applicationCode" : "applicationData" : savedPhase;
      patchCount++;
      installing = ` while installing bank ${patch.at.bank}, offset ${patch.at.offset}`;
      const anchor = address(patch.at);
      const valueKey = cacheKey(patch.value), repeating = typeof patch.value === "string" && patch.value.at(-1) === "1";
      if (preimages.has(valueKey)) {
        // A cached S(value) can be read directly after resetting the target.
        // Avoid rebuilding it in COPY for every byte of padded application code.
        prepareTarget(patch.at, anchor);
        read(cache.get(valueKey)!, !repeating);
        high(patch.at, "p", anchor); written.add(key(patch.at)); replaced.set(key(patch.at), patch.value);
        continue;
      }
      // Build before resetting the target: build/read may use all low work cells.
      const value = cache.get(valueKey) ?? build(patch.value);
      const isOne = value === ONE;
      reset(COPY); if (isOne) ones(); else read(value, typeof patch.value === "string" && patch.value.at(-1) === "1"); op(COPY, "p");
      // COPY now holds S(value). Preserve it while resetting the destination.
      prepareTarget(patch.at, anchor);
      read(COPY, !isOne && typeof patch.value === "string" ? patch.value.at(-1) !== "1" : !isOne);
      high(patch.at, "p", anchor); written.add(key(patch.at)); replaced.set(key(patch.at), patch.value);
    }
    phase = savedPhase;
  };
  install(image.patches);
  const marker = image.symbols.get("marker")!;
  const anchor = address(marker);
  for (let i = 0; i < shift; i++) high(marker, "*", anchor);
  let returnAt = 0;
  if (application) {
    const ret = image.symbols.get("sourceReturn");
    if (!ret) throw new Error("linked bootstrap requires a source-return payload");
    let k = 1; while (2 * 3 ** k < c + 20_000) k++;
    if (k > shift) throw new RangeError("bootstrap return exceeds the calibration shift");
    returnAt = 2 * 3 ** k;
    const anchor = address(ret);
    for (let i = 0; i < shift - k; i++) high(ret, "*", anchor);
  }
  const next = image.symbols.get("next")!;
  copy(ADDRESS, build({ bank: next.bank, offset: next.offset - 1 }));
  chunk(["j", "j", "i"]);
  if (application) {
    if (c > returnAt) throw new RangeError("bootstrap return overlaps its installer");
    while (c <= returnAt) raw("o");
    raw("j"); // D=sourceReturn+1 contains 38: resume low-bank operations at D=39.
    phase = "wideSeeds";
    cache.clear(); preimages.clear(); addressKey = "";
    // Copy the calibrated 2*3^30 into a low seed register, without rotating it.
    const payload = image.symbols.get("payload")!;
    const anchor = address(payload);
    reset(111); reset(COPY); ones(); high(payload, "p", anchor); op(COPY, "p"); op(111, "p");
    // The wide read mask includes both the bank coefficients and low 31 trits.
    copy02(116, 111);
    // The low four masks already belong to MAX; the disjoint-mask union
    // must only add the remaining positions 4 through 30.
    for (let i = 0; i < 27; i++) { union(MAX, MAX, 116); if (i < 26) op(116, "*"); }
    wide = true;
    // Most code/data offsets use these bits. Build each mask once instead of
    // copying 2*3^30 and rotating it dozens of times for every address digit.
    const seedSlots = [45, 47, 50, 52, 53, 55, 57, 59, 61, 64, 66, 68, 70, 72, 74, 76, 78];
    lowSeeds.set(30, 111);
    seedSlots.forEach((slot, i) => { copy02(slot, 111); op(slot, "*", 26 - i); lowSeeds.set(i + 4, slot); });
    if (options.compact !== false) {
      const originals = ["22021", "20110", "12021", "20120", "2201", "10120"];
      // Two masks already exist as low-trit seeds. Keep the cheapest cache
      // slots available for the much more frequent padded-code value reads.
      for (const [i, slot] of [112, TWO, 113, 114, 115, LOW[3]].entries()) {
        if (i !== 1 && i !== 5) {
          const mask = Array.from(originals[i], (digit) => digit === "2" ? "2" : "0").join("").replace(/0+$/, "") + "0";
          copy02(slot, build(mask));
        }
        fillMasks.push(slot);
      }
    }
    const installImage = (patches: Patch[]) => {
      cache.clear(); preimages.clear(); addressKey = "";
      const frequency = new Map<string, { value: BankWord | Trits; count: number }>();
      for (const p of patches) if (p.value !== "1") {
        const key = cacheKey(p.value), entry = frequency.get(key);
        if (entry) entry.count++; else frequency.set(key, { value: p.value, count: 1 });
      }
      // Widening and seed unions are finished. Reuse their dead scratch cells and
      // unused low cells, keeping dispatch/return cells, masks, and WORK intact.
      // Put frequent values near D=39 to shorten every cached-value read.
      const cacheSlots = [40, 41, 42, 54, 77, 80, 82, 83, 84, 86, 88, 90, 92, 94, 97, 98, ...(fillMasks.length ? [] : [112, 113, 114, 115]), 117, 119, 120, 121, 122, 123];
      for (const [key, { value: word }] of [...frequency].filter(([, e]) => e.count >= 3).sort((a, b) => b[1].count - a[1].count).slice(0, cacheSlots.length)) {
        const slot = cacheSlots.shift()!, value = build(word);
        reset(slot); read(value, typeof word === "string" && word.at(-1) === "1"); op(slot, "p");
        cache.set(key, slot); preimages.add(key);
      }
      install(patches);
    };
    if (options.installer) {
      const loader = options.installer;
      phase = "decoder"; installImage(loader.patches);
      // The target decoder returns to a forward source continuation. A fixed
      // margin covers construction of its finite return address and entry.
      const resumeAt = c + 200_000;
      install([{ at: loader.resume, value: fromNumber(resumeAt - 1) }]);
      copy(ADDRESS, build({ bank: loader.next.bank, offset: loader.next.offset - 1 }));
      chunk(["j", "j", "i"]);
      if (c > resumeAt) throw new RangeError("decoder return overlaps installer");
      phase = "decoderReturnPadding";
      while (c < resumeAt) raw("o"); raw("j");
      filled = loader.fill;
    }
    phase = "application";
    installImage(application.patches.filter((patch) => !isFilled(patch.at) || patch.value !== filled!.value));
    // Application native reads use this same complete mask.
    copy(ADDRESS, build({ bank: application.next.bank, offset: application.next.offset - 1 }));
    chunk(["j", "j", "i"]);
  }
  phase = "suffix";
  // A fixed fill phase: rest[3]=65. The trailing instructions are never run.
  while ((c + 2) % 282 !== 2) raw("o"); raw("p"); raw("*");
  // At residues 0 and 1 these last two bytes are 62 and 38.
  blocks.push(block.slice(0, used));
  const source = blocks.map((part) => String.fromCharCode(...part)).join("");
  return { source, basisRegister: HIGH[5], symbols: image.symbols, codeCells: image.codeCells, shift, statistics: { sourceCells: source.length, phases, patches: patchCount, generatedPaddingCells: filled ? filled.end - filled.start : 0, installer: filled ? "loop" : "unrolled" } };
}
