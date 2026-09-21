/** Register applications linked to the input-free, growing-width bootstrap. */
import { fromBigInt, fromNumber } from "../malbolge/trits.js";
import { bootstrapCycleImage, installBootstrap, type BankWord, type BootstrapImage } from "./bootstrap.js";
import { BankLayout, bankKey, type BankValue, type BankNative } from "./banked.js";
import { fixedWord } from "./init.js";
import type { RegisterLoopProgram } from "./register-loop.js";
import { valueForOp } from "./cycles.js";

export interface BootstrappedLoopImage extends BootstrapImage {
  /** Logical word width; the interpreter chooses the physical rotation width. */
  width: number;
  /** Resolve bank-relative addresses using half the value of basisRegister. */
  applicationSymbols: Map<string, BankWord>;
  arrays: Map<string, { base: number; stride: number; cells: BankWord[] }>;
}

/** Shared native operations. Reads use masks, never a guessed full rotation. */
class NativeBuilder {
  body: BankNative[] = [];
  constructor(readonly layout: BankLayout, readonly values: Map<string, BankValue>) {}
  reg(name: string, value: BankValue = "0"): string {
    this.layout.reg(name); if (!this.values.has(name)) this.values.set(name, value); return name;
  }
  emit(op: BankNative["op"], register: string, count = 1): void {
    for (let i = 0; i < count; i++) this.body.push({ op, register });
  }
  ones(): void { this.emit("*", "$bank.one"); }
  reset(dest: string, zero = false): void { this.ones(); this.emit("p", dest, zero ? 3 : 2); }
  read02(src: string): void { this.ones(); this.emit("p", src); }
  mask(): void { this.reset("$mask"); this.read02("$max"); this.emit("p", "$mask"); }
  read(src: string, base = 0): void {
    if (src === "$bank.one") { this.ones(); return; }
    if (src === "$max") { this.read02(src); return; }
    for (let i = 0; i < 2; i++) {
      if (base === 1) this.read02("$max"); else this.mask();
      this.emit("p", src);
    }
  }
  copy(dest: string, src: string, base = 0): void {
    if (dest === src) return;
    this.reset(dest); this.reset("$copy"); this.read(src, base); this.emit("p", "$copy"); this.emit("p", dest);
  }
  /** Clear all trits outside a finite 0/2 mask; keep selected trits unchanged. */
  clip(dest: string, mask: string): void {
    // C(C(mask,C(x,x)),C(C(x,0),0)) keeps x where mask=2 and
    // clears it where mask=0, including trits above the read window.
    this.copy("$clip0", dest); this.copy("$clip1", dest);
    this.emit("p", "$clip0"); this.read02(mask); this.emit("p", "$clip0");
    this.reset("$clip1", true); this.read(dest); this.emit("p", "$clip1");
    this.reset("$clip2", true); this.read("$clip1", 1); this.emit("p", "$clip2");
    this.read("$clip0", 1); this.emit("p", "$clip2"); this.copy(dest, "$clip2");
  }
}

/**
 * Plan a do/while register application for conforming, growing Unshackled.
 * `width` is the logical arithmetic width; it is independent of physical rotation.
 * Modified registers start finite and are normalized at iteration boundaries.
 */
export function planBootstrappedLoop(program: RegisterLoopProgram) {
  fixedWord(0, program.width);
  const cycle = bootstrapCycleImage(59, true), cycleNext = cycle.symbols.get("next")!, next = { bank: 650, offset: 80 };
  const layout = new BankLayout(next, cycle.symbols.get("one.0")!);
  for (const patch of cycle.patches) layout.patch(patch.at, patch.value);
  const values = new Map<string, BankValue>();
  const n = new NativeBuilder(layout, values);
  layout.symbols.set("$next", next);
  layout.symbols.set("$return", { bank: cycleNext.bank, offset: cycleNext.offset + 1 });
  layout.patches.delete(bankKey({ bank: cycleNext.bank, offset: cycleNext.offset + 1 }));
  for (const [name, at] of cycle.symbols) layout.symbols.set(`$cycle.${name}`, at);
  for (const name of ["$mask", "$copy", "$max", "$clip0", "$clip1", "$clip2", "$save", "$rotated", "$sum0", "$sum1", "$sum2", "$flag", "$zero", "$pointer", "$capture", "$storevalue", "$ptr0", "$ptr1", "$ptr2"]) n.reg(name);
  // Indirect steering spans 90 cells; leave room for its pointer in this bank.
  layout.symbols.set("$pointer", { ...layout.reg("$pointer"), offset: 180 });
  const limit = 3n ** BigInt(program.width);
  const constant = (value: BankValue): string => {
    const id = typeof value === "string" ? `t${value}` : `p${bankKey(value)}`;
    return n.reg(`$constant.${id}`, value);
  };
  const maxWord = constant(fromBigInt(limit - 1n));
  const requireRegister = (name: string) => {
    if (!Object.hasOwn(program.registers, name)) throw new RangeError(`unknown register ${name}`);
  };
  requireRegister(program.while);
  const bases = new Map<string, number>();
  const mutated = new Set(program.body.flatMap((i) => "dest" in i ? [i.dest] : []));
  for (const [name, value] of Object.entries(program.registers)) {
    if (name.startsWith("$")) throw new RangeError("reserved bootstrapped register name");
    const word = fixedWord(value, program.width);
    if (mutated.has(name) && word.at(-1) !== "0") throw new RangeError("modified loop registers must start as finite words");
    n.reg(name, word); bases.set(name, Number(word.at(-1)));
  }
  const applicationSymbols = new Map(Object.keys(program.registers).map((name) => [name, layout.reg(name)]));
  const arrays = new Map<string, { base: number; stride: number; cells: BankWord[] }>();
  let arrayOffset = 80;
  for (const [name, contents] of Object.entries(program.arrays ?? {})) {
    if (!contents.length) throw new RangeError(`array ${name} must not be empty`);
    // Logical pointers index a fixed table; the table dispatch is emitted below.
    const cells = contents.map((value, i) => {
      const word = fixedWord(value, program.width);
      if (word.at(-1) !== "0") throw new RangeError("loop arrays require finite words");
      const register = `$array.${name}.${i}`; n.reg(register, word);
      const at = layout.reg(register), capture = layout.reg("$capture");
      layout.patch({ bank: 652, offset: arrayOffset + 3 * i + 3 }, { bank: at.bank, offset: at.offset - 18 });
      layout.patch({ bank: at.bank, offset: at.offset + 72 }, { bank: capture.bank, offset: capture.offset - 22 });
      return at;
    });
    arrays.set(name, { base: arrayOffset, stride: 3, cells }); arrayOffset += 3 * contents.length;
  }
  if (BigInt(arrayOffset) >= limit) throw new RangeError("arrays exceed the logical pointer width");

  // Each call site is a restorable fragment. The shared rotation cycle returns
  // through NEXT+1, then the fragment resumes with D=NEXT+2 (entry shim below).
  const pending: { name: string; body: BankNative[]; destination: string }[] = [];
  let fragment = 0;
  const flush = (destination: string) => {
    const name = `$fragment.${fragment++}`;
    pending.push({ name, body: n.body, destination }); n.body = [];
    return name;
  };
  const copy = (dest: string, src: string) => { n.copy(dest, src, bases.get(src) ?? (values.get(src) === "1" ? 1 : 0)); bases.set(dest, bases.get(src) ?? Number(typeof values.get(src) === "string" ? (values.get(src) as string).at(-1) : 0)); };
  const c = (dest: string, a: string, b: string) => {
    if (dest === a && dest !== b) { copy("$save", a); a = "$save"; }
    if (!bases.has(a)) bases.set(a, Number(typeof values.get(a) === "string" ? (values.get(a) as string).at(-1) : 0));
    copy(dest, b); n.read(a, bases.get(a) ?? 0); n.emit("p", dest); bases.set(dest, 1 - (bases.get(a) ?? 0));
  };
  const rotate = (dest: string, count: number) => {
    const k = count % program.width; if (!k) return;
    if (bases.get(dest) === 1) throw new RangeError("logical rotation requires a finite word");
    // A right rotation supplies the lower segment. The shared cycle moves the
    // wrapped segment left by width-k, regardless of the physical width.
    copy("$cycle.payload", dest); copy("$rotated", dest); n.emit("*", "$rotated", k);
    const low = constant(fromBigInt(3n ** BigInt(program.width - k) - 1n));
    n.clip("$rotated", low); bases.set("$rotated", 0);
    for (const [name, value] of Object.entries({ test: "121", z0: fromNumber(3), z1: "101", d6: fromNumber(3), d3: "101", marker: fromNumber(3) })) {
      const src = constant(value); n.copy(`$cycle.${name}`, src, Number(value.at(-1)));
    }
    n.emit("*", "$cycle.marker", program.width - k);
    const returnName = `$fragment.${fragment + 1}`;
    // Tag the constant separately so it can be relocated after layout.
    const reloc = n.reg(`$resume.${fragment}`); values.set(reloc, { bank: 0, offset: 0 });
    n.copy("$return", reloc);
    n.copy("$cycle.next", constant({ bank: 188, offset: 59 }));
    flush("$rotation");
    // The return jump uses cycle NEXT+1 and reaches the entry with D=NEXT+2.
    resumeTargets.set(reloc, returnName);
    const high = constant(fromBigInt(limit - 3n ** BigInt(program.width - k)));
    n.clip("$cycle.payload", high); bases.set("$cycle.payload", 0);
    // Tritwise sum, with disjoint supports (there is no carry).
    c("$sum0", "$rotated", "$cycle.payload"); c("$sum0", maxWord, "$sum0");
    c("$sum1", "$cycle.payload", "$rotated"); c("$sum2", maxWord, "$cycle.payload");
    c("$sum2", "$cycle.payload", "$sum2"); c("$sum2", "$sum1", "$sum2"); c(dest, "$sum0", "$sum2");
    n.clip(dest, maxWord); bases.set(dest, 0);
  };
  const indirectPointer = (source: string) => {
    copy("$pointer", source);
    const bank = constant({ bank: 652, offset: 0 });
    // Disjoint finite words: bank coefficient plus logical array offset.
    c("$ptr0", "$pointer", bank); c("$ptr0", "$max", "$ptr0");
    c("$ptr1", bank, "$pointer"); c("$ptr2", "$max", bank);
    c("$ptr2", bank, "$ptr2"); c("$ptr2", "$ptr1", "$ptr2"); c("$pointer", "$ptr0", "$ptr2");
  };
  const indirect = () => n.body.push({ op: "p", register: "$pointer", indirect: { capture: "$capture" } });
  const dataMask = () => { n.reset("$mask"); n.read02(maxWord); n.emit("p", "$mask"); };
  const resumeTargets = new Map<string, string>();
  // Normalize modified registers at the loop boundary so every iteration has
  // the same known repeating bases, including the first iteration.
  for (const name of mutated) {
    requireRegister(name);
    const first = program.body.find((inst) => ["dest", "source", "pointer", "a", "b"].some(
      (field) => (inst as unknown as Record<string, string>)[field] === name));
    if (first && "dest" in first && first.dest === name && ["set", "getc", "array-base"].includes(first.op)) continue;
    n.clip(name, maxWord); bases.set(name, 0);
  }
  for (const inst of program.body) {
    for (const field of ["dest", "source", "pointer", "a", "b"] as const) if (field in inst) requireRegister((inst as unknown as Record<string, string>)[field]);
    switch (inst.op) {
      case "require-width": if (inst.width !== program.width) throw new RangeError("arithmetic width does not match loop width"); break;
      case "set": { const word = fixedWord(inst.value, program.width); const src = constant(word); bases.set(src, Number(word.at(-1))); copy(inst.dest, src); break; }
      case "copy": copy(inst.dest, inst.source); break;
      case "crazy": c(inst.dest, inst.a, inst.b); break;
      case "rotate": { const count = inst.count ?? 1; if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("invalid rotation count"); rotate(inst.dest, count); break; }
      case "getc": n.reset(inst.dest); n.reset("$copy"); n.emit("/", "$copy"); n.emit("p", "$copy"); n.emit("p", inst.dest); bases.set(inst.dest, 0); break;
      case "putc": n.read(inst.source, bases.get(inst.source) ?? 0); n.emit("<", inst.source); break;
      case "array-base": { const array = arrays.get(inst.array); if (!array) throw new RangeError(`unknown array ${inst.array}`); copy(inst.dest, constant(fromNumber(array.base - 1))); break; }
      case "load": {
        indirectPointer(inst.pointer); n.reset(inst.dest);
        n.reset("$capture"); dataMask(); indirect();
        n.reset("$capture"); dataMask(); indirect(); n.emit("p", inst.dest); bases.set(inst.dest, 0); break;
      }
      case "store": {
        indirectPointer(inst.pointer); copy("$storevalue", inst.source); n.clip("$storevalue", maxWord);
        n.reset("$save"); n.reset("$capture"); n.ones(); indirect(); n.emit("p", "$save"); indirect();
        n.reset("$save"); n.read("$storevalue"); n.emit("p", "$save"); indirect(); break;
      }
    }
  }
  // Turn boolean 0/1 into a base-1 selector with low trit 1/2.
  // Applying it to NEXT selects offsets 24 (halt) or 26 (repeat).
  copy("$flag", program.while);
  n.copy("$next", constant({ bank: 564, offset: 25 }));
  n.reset("$zero"); n.read(constant("21"), 1); n.emit("p", "$flag");
  n.emit("p", "$zero"); n.emit("p", "$next");
  flush("$branch-ready");

  // Block targets are data constants, allowing layout before pointer emission.
  const entries = new Map<string, BankWord>();
  for (const part of pending) {
    if (part.destination !== "$branch-ready") n.copy("$next", n.reg(`$target.${part.name}`));
    part.body.push(...n.body); n.body = [];
    entries.set(part.name, layout.block(part.body));
  }
  entries.set("$rotation", { bank: 188, offset: 59 });
  for (let i = 0; i < pending.length; i++) {
    const part = pending[i];
    if (part.destination !== "$branch-ready") values.set(`$target.${part.name}`, entries.get(part.destination)!);
  }
  for (const [reg, target] of resumeTargets) values.set(reg, entries.get(target)!);
  const first = entries.get("$fragment.0")!;
  const onePointer = { bank: layout.one.bank, offset: layout.one.offset - 3 };
  // Normal entries, cycle calls, returns, and the final loop back-edge share
  // the same first operation but arrive with slightly different D offsets.
  layout.patch({ bank: next.bank, offset: next.offset + 95 }, onePointer);
  layout.patch({ bank: next.bank, offset: next.offset + 56 }, onePointer);
  layout.patch({ bank: cycleNext.bank, offset: cycleNext.offset + 56 }, onePointer);
  layout.patch({ bank: next.bank, offset: next.offset + 1 }, first);
  layout.patch({ bank: 564, offset: 24 }, fromNumber(74));
  layout.patch({ bank: 564, offset: 25 }, fromNumber(valueForOp("v", 25)));
  layout.patch({ bank: 564, offset: 26 }, fromNumber(74));
  layout.patch({ bank: 564, offset: 27 }, fromNumber(valueForOp("i", 27)));
  layout.patches.set(bankKey({ bank: cycleNext.bank, offset: cycleNext.offset + 1 }), {
    at: { bank: cycleNext.bank, offset: cycleNext.offset + 1 }, value: "0",
  });
  layout.patches.set(bankKey({ bank: 188, offset: 57 }), {
    at: { bank: 188, offset: 57 }, value: fromNumber(valueForOp("i", 57)),
  });
  values.set("$max", { bank: 728, offset: 3 ** 31 - 1 });
  for (const [name, value] of values) layout.patch(layout.reg(name), value);
  for (const [name, at] of layout.symbols) if (!layout.patches.has(bankKey(at))) layout.patch(at, name === "$next" ? first : "0");
  return { patches: [...layout.patches.values()], symbols: cycle.symbols, codeCells: layout.patches.size, width: program.width, applicationSymbols, arrays, registerSymbols: layout.symbols, entry: first, next };
}

/** Emit legal, input-free installation source. The default budget is 500 million cells. */
export function assembleBootstrappedLoop(program: RegisterLoopProgram, options: { maxSourceCells?: number } = {}): BootstrappedLoopImage {
  const plan = planBootstrappedLoop(program);
  const linked = installBootstrap(bootstrapCycleImage(59, true), 30, options.maxSourceCells ?? 500_000_000, 3, plan);
  return { ...linked, codeCells: plan.codeCells, width: plan.width, applicationSymbols: plan.applicationSymbols, arrays: plan.arrays };
}
