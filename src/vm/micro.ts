/** Internal threaded register machine: shared native primitives, routines as data. */
import { BankLayout, bankKey, type BankValue } from "../hell/banked.js";
import { bootstrapCycleImage, type BankWord } from "../hell/bootstrap.js";
import { NativeBuilder } from "../hell/native.js";
import { valueForOp } from "../hell/cycles.js";
import { fromBigInt, fromNumber, type Trits } from "../malbolge/trits.js";

export interface Frame { pointer: BankWord; fields: BankWord[] }
export interface MicroLabel { label: string }
export interface MicroRegister { frame: Frame; base: number }
type Value = BankValue | MicroLabel;
interface MicroInstruction { op: string; a?: MicroRegister | MicroLabel; b?: MicroRegister | MicroLabel; c?: MicroLabel; d?: MicroLabel }
const offset02 = (i: number) => parseInt((i + 1).toString(2).replace(/1/g, "2"), 3);
const isLabel = (v: Value): v is MicroLabel => typeof v === "object" && "label" in v;

/** Records, registers, and memory frames share the same relocated data layout. */
export class MicroBuilder {
  readonly cycle = bootstrapCycleImage(59, true);
  readonly next: BankWord = { bank: 650, offset: 80 };
  readonly layout = new BankLayout(this.next, this.cycle.symbols.get("one.0")!, { bank: 564, residue: 2, entries02: false });
  readonly nativeValues = new Map<string, BankValue>();
  readonly native = new NativeBuilder(this.layout, this.nativeValues);
  readonly registers = new Map<string, MicroRegister>();
  readonly nativeHandlers = new Map<string, BankWord>();
  readonly labels = new Map<string, number>();
  readonly instructions: MicroInstruction[] = [];
  private readonly pending: { at: BankWord; value: Value }[] = [];
  private readonly constants = new Map<string, MicroRegister>();
  private frameCount = 0;
  private serial = 0;
  private needsRotation = false;
  constructor(readonly width: number) {}
  label(name: string): MicroLabel { return { label: name }; }
  mark(label: MicroLabel): void {
    if (this.labels.has(label.label)) throw new Error(`duplicate micro label ${label.label}`);
    this.labels.set(label.label, this.instructions.length);
  }
  unique(name: string): MicroLabel { return this.label(`${name}.${this.serial++}`); }
  frame(): Frame {
    const row = this.frameCount++;
    const f = { pointer: { bank: 728, offset: offset02(row) }, fields: Array.from({ length: 6 }, (_, field) => ({ bank: 700, offset: 80 + 752 * row + 94 * field })) };
    this.layout.patch({ ...f.pointer, offset: f.pointer.offset + 4 }, { ...f.fields[0], offset: f.fields[0].offset - 18 });
    return f;
  }
  fill(frame: Frame, values: (Value | undefined)[]): void {
    const capture = this.layout.reg("$capture");
    values.forEach((value, field) => {
      if (value === undefined) return;
      const at = frame.fields[field];
      this.pending.push({ at, value });
      this.layout.patch({ ...at, offset: at.offset + 72 }, { ...capture, offset: capture.offset - 22 });
    });
  }
  reg(name: string, value: Value = "0"): MicroRegister {
    const old = this.registers.get(name); if (old) return old;
    const r = { frame: this.frame(), base: typeof value === "string" ? Number(value.at(-1)) : 0 };
    this.registers.set(name, r); this.fill(r.frame, [value]); return r;
  }
  constant(value: Value): MicroRegister {
    const key = typeof value === "string" ? value : isLabel(value) ? `label:${value.label}` : `bank:${bankKey(value)}`;
    let reg = this.constants.get(key);
    if (!reg) { reg = this.reg(`$constant.${key}`, value); this.constants.set(key, reg); }
    return reg;
  }
  emit(op: string, a?: MicroRegister | MicroLabel, b?: MicroRegister | MicroLabel): void { this.instructions.push({ op, a, b }); }
  mov(dest: MicroRegister, source: MicroRegister): void {
    if (dest === source) return;
    this.emit(source.base === 1 ? "mov1" : "mov", source, dest); dest.base = source.base;
  }
  set(dest: MicroRegister, value: Value): void { this.mov(dest, this.constant(value)); }
  crazy(dest: MicroRegister, a: MicroRegister, b: MicroRegister): void {
    if (dest === a && dest !== b) { const save = this.reg("$alias"); this.mov(save, a); a = save; }
    const base = a.base;
    this.mov(dest, b); this.emit(base === 1 ? "p1" : "p", a, dest); dest.base = 1 - base;
  }
  rotate(dest: MicroRegister, count = 1): void { for (let i = 0; i < count; i++) this.emit("rotate", dest); }
  rol(dest: MicroRegister): void {
    this.needsRotation = true;
    const resume = this.unique("$rol.resume");
    this.set(this.reg("$rol.argument"), dest.frame.pointer); this.set(this.reg("$rol.return"), resume);
    this.jump(this.label("$rol.entry")); this.mark(resume); dest.base = 0;
  }
  get(dest: MicroRegister, source: MicroRegister, field: number): void { this.emit(`get${field}`, source, dest); dest.base = 0; }
  put(dest: MicroRegister, field: number, source: MicroRegister): void { this.emit(`put${field}`, source, dest); }
  jump(label: MicroLabel): void { this.emit("jump", label); }
  ijump(reg: MicroRegister): void { this.emit("ijump", reg); }
  jz(reg: MicroRegister, label: MicroLabel): void { this.emit("jz", reg, label); }
  branch3(reg: MicroRegister, zero: MicroLabel, one: MicroLabel, two: MicroLabel): void { this.instructions.push({ op: "branch3", a: reg, b: zero, c: one, d: two }); }
  clip(dest: MicroRegister, mask: MicroRegister): void {
    const x = this.reg("$clip.x"), y = this.reg("$clip.y"), z = this.reg("$clip.z"), zero = this.constant("0");
    this.crazy(x, dest, dest); this.crazy(x, mask, x);
    this.crazy(y, dest, zero); this.crazy(z, y, zero); this.crazy(z, x, z); this.mov(dest, z);
  }

  private installNative() {
    const n = this.native, values = this.nativeValues, layout = this.layout;
    const used = new Set(this.instructions.map((i) => i.op));
    if (used.has("cycle")) for (const patch of this.cycle.patches) layout.patch(patch.at, patch.value);
    n.compactResets = true;
    layout.symbols.set("$next", this.next);
    for (const name of ["$mask", "$max", "$copy", "$pointer", "$capture", "$storevalue", "$save", "$readmask", "$zero", "$result", "$selector", "$clip0", "$clip1", "$clip2", "$input", "$inputflag", "$rotated", "$sum0", "$sum1", "$sum2", "$uPC", "$address", "$dest", "$value", "$base", "$flag"]) n.reg(name);
    for (const name of ["$pointer", "$uPC", "$address", "$dest"]) layout.symbols.set(name, { ...layout.reg(name), offset: 180 });
    for (const name of ["$uPC", "$address", "$dest", "$base"]) n.words02.add(name);
    values.set("$max", { bank: 728, offset: 3 ** 31 - 1 });
    const constant = (value: BankValue) => n.reg(`$native.constant.${typeof value === "string" ? value : bankKey(value)}`, value);
    const target = (name: string) => n.reg(`$native.target.${name}`);
    const indirect = (field: number, pointer = "$pointer") => n.body.push({ op: "p", register: pointer, indirect: { capture: "$capture", field } });
    const read = (dest: string, pointer: string, field: number, mode: "pointer" | "word" | "base1" = "pointer") => {
      const out = dest === pointer ? "$result" : dest;
      n.reset(out);
      for (let i = 0; i < (mode === "pointer" ? 1 : 2); i++) {
        // Only the final capture is consumed. The first pass of a restoring
        // read may leave arbitrary scratch data in CAPTURE.
        if (mode === "pointer" || i === 1) n.reset("$capture");
        if (mode === "pointer") n.ones(); else if (mode === "base1") n.read02("$max"); else n.mask();
        indirect(field, pointer);
      }
      n.emit("p", out);
      if (out !== dest) {
        if (mode === "pointer") n.words02.add(out);
        n.copy(dest, out, mode === "base1" ? 1 : 0); n.words02.delete(out);
      }
    };
    const write = (pointer: string, field: number, source: string, base = 0) => {
      // SOURCE is a native temporary, disjoint from every data-frame target.
      n.copy("$pointer", pointer);
      n.reset("$save"); n.reset("$capture"); n.ones(); indirect(field); n.emit("p", "$save"); indirect(field);
      n.reset("$save"); n.read(source, base); n.emit("p", "$save"); indirect(field);
    };
    const block = (name: string, body: () => void) => { body(); this.nativeHandlers.set(name, layout.block(n.body)); n.body = []; };
    const advance = () => n.copy("$next", target("advance"));
    const writeResult = (base = 0) => n.copy("$next", target(base ? "write1" : "write"));
    const operand = (dest: string, field: number) => read(dest, "$uPC", field);
    block("setup", () => { n.reset("$readmask"); n.read02("$max"); n.emit("p", "$readmask"); n.copy("$next", target("fetch")); });
    n.readMask = { mask: "$readmask", zero: "$zero" };
    // Fetch operands once for every primitive, instead of duplicating their
    // indirect read sequences in each native handler.
    block("fetch", () => { operand("$address", 1); operand("$dest", 2); read("$next", "$uPC", 0, "word"); });
    block("advance", () => { read("$uPC", "$uPC", 5); n.copy("$next", target("fetch")); });
    block("write", () => { write("$dest", 0, "$value"); advance(); });
    if (used.has("mov1")) block("write1", () => { write("$dest", 0, "$value", 1); advance(); });
    for (const [op, base] of [["mov", 0], ["mov1", 1]] as const) if (used.has(op)) block(op, () => {
      read("$value", "$address", 0, base ? "base1" : "word"); writeResult(base);
    });
    for (const [op, base] of [["p", 0], ["p1", 1]] as const) if (used.has(op)) block(op, () => {
      n.copy("$pointer", "$dest");
      read("$value", "$address", 0, base ? "base1" : "word");
      // The read leaves the restored source in A. The raw operation's capture
      // is discarded, so no second read or capture reset is needed.
      indirect(0); advance();
    });
    for (let field = 0; field < 6; field++) {
      if (used.has(`get${field}`)) block(`get${field}`, () => {
        read("$address", "$address", 0);
        read("$value", "$address", field, "word"); writeResult();
      });
      if (used.has(`put${field}`)) block(`put${field}`, () => {
        read("$value", "$address", 0, "word");
        read("$dest", "$dest", 0);
        if (field === 0) writeResult(); else { write("$dest", field, "$value"); advance(); }
      });
    }
    if (used.has("jump")) block("jump", () => { n.copy("$uPC", "$address"); n.copy("$next", target("fetch")); });
    if (used.has("ijump")) block("ijump", () => { read("$uPC", "$address", 0); n.copy("$next", target("fetch")); });
    for (const op of ["jz", "branch3"]) if (used.has(op)) {
      // A=swap01(flag), applied to a ...001 table pointer, selects its low trit.
      const base = 2 * 3 ** 25 + (op === "jz" ? 0 : 18);
      block(op, () => {
        read("$flag", "$address", 0, "word");
        n.copy("$pointer", constant({ bank: 728, offset: base + 1 }));
        n.reset("$selector"); n.read("$flag"); n.emit("p", "$selector"); n.emit("p", "$pointer");
        read("$next", "$pointer", 0, "word");
      });
      for (let flag = 0; flag < 3; flag++) block(`${op}.${flag}`, () => {
        if (op === "jz" && flag !== 0) advance();
        else { if (flag === 0) n.copy("$uPC", "$dest"); else operand("$uPC", flag + 2); n.copy("$next", target("fetch")); }
      });
      for (let flag = 0; flag < 3; flag++) {
        const f = this.frame(); this.fill(f, [this.nativeHandlers.get(`${op}.${flag}`)!]);
        layout.patch({ bank: 728, offset: base + flag + 4 }, { ...f.fields[0], offset: f.fields[0].offset - 18 });
      }
    }
    for (const [op, count] of [["rotate", 1], ["top", this.width - 1]] as const) if (used.has(op)) block(op, () => {
      n.copy("$dest", "$address"); read("$value", "$dest", 0, "word"); n.emit("*", "$value", count); writeResult();
    });
    if (used.has("out")) block("out", () => {
      read("$value", "$address", 0, "word"); n.emit("<", "$value"); advance();
    });
    if (used.has("in")) block("in", () => {
      n.copy("$base", "$address"); n.copy("$address", "$dest"); n.copy("$dest", "$base");
      n.reset("$input"); n.reset("$copy"); n.emit("/", "$copy"); n.emit("p", "$copy"); n.emit("p", "$input");
      n.copy("$inputflag", "$input"); n.emit("*", "$inputflag", 14); n.clip("$inputflag", constant(fromNumber(2)));
      n.clip("$input", constant(fromBigInt(3n ** 20n - 1n)));
      write("$dest", 0, "$input"); write("$address", 0, "$inputflag"); advance();
    });
    if (used.has("cycle")) {
      const cycle = this.cycle, cycleNext = cycle.symbols.get("next")!;
      layout.symbols.set("$return", { ...cycleNext, offset: cycleNext.offset + 1 });
      layout.patches.delete(bankKey({ ...cycleNext, offset: cycleNext.offset + 1 }));
      for (const [name, at] of cycle.symbols) layout.symbols.set(`$cycle.${name}`, at);
      block("cycle", () => {
        n.copy("$dest", "$address"); read("$value", "$dest", 0, "word");
        n.copy("$cycle.payload", "$value");
        for (const [name, value] of Object.entries({ test: "121", z0: fromNumber(3), z1: "101", d6: fromNumber(3), d3: "101", marker: fromNumber(3) })) n.copy(`$cycle.${name}`, constant(value), Number(value.at(-1)));
        n.emit("*", "$cycle.marker");
        n.copy("$return", target("cycle.done")); n.copy("$cycle.next", constant({ bank: 188, offset: 59 }));
        n.copy("$next", constant({ bank: 188, offset: 59 }));
      });
      block("cycle.done", () => { n.copy("$value", "$cycle.payload"); writeResult(); });
      const one = { ...layout.one, offset: layout.one.offset - 3 };
      layout.patch({ ...this.next, offset: this.next.offset + 95 }, one);
      // Micro handlers enter at residue 2 (the register-loop backend uses 5).
      // Returning from the cycle leaves D=cycleNext+2; its first j is 57 later.
      layout.patch({ ...cycleNext, offset: cycleNext.offset + 59 }, one);
      layout.patches.set(bankKey({ ...cycleNext, offset: cycleNext.offset + 1 }), { at: { ...cycleNext, offset: cycleNext.offset + 1 }, value: "0" });
      layout.patches.set("188:57", { at: { bank: 188, offset: 57 }, value: fromNumber(valueForOp("i", 57)) });
    }
    for (const [name, address] of this.nativeHandlers) values.set(target(name), address);
  }

  finish(entryLabel: MicroLabel, faults: Record<string, number>) {
    if (this.needsRotation) {
      this.mark(this.label("$rol.entry"));
      const value = this.reg("$rol.value"), high = this.reg("$rol.high"), x = this.reg("$rol.x"), y = this.reg("$rol.y"), z = this.reg("$rol.z");
      const max = this.constant(fromBigInt(3n ** BigInt(this.width) - 1n));
      this.get(value, this.reg("$rol.argument"), 0); this.mov(high, value); this.emit("top", high); this.clip(high, this.constant(fromNumber(2)));
      this.emit("cycle", value); this.clip(value, max);
      this.crazy(x, high, value); this.crazy(x, max, x); this.crazy(y, value, high);
      this.crazy(z, max, value); this.crazy(z, value, z); this.crazy(z, y, z); this.crazy(value, x, z);
      this.clip(value, max); this.put(this.reg("$rol.argument"), 0, value); this.ijump(this.reg("$rol.return"));
    }
    this.installNative();
    const faultAddresses = new Map<number, BankWord>();
    for (const [name, number] of Object.entries(faults)) {
      // An execution bank divisible by 94, above the cycle's code. Both bank
      // and entry have only 0/2 trits, like all native dispatch targets.
      const at = { bank: 188, offset: 2 * 3 ** 20 + offset02(number) };
      this.layout.patch(at, fromNumber(74)); this.layout.patch({ ...at, offset: at.offset + 1 }, fromNumber(valueForOp("v", at.offset + 1)));
      faultAddresses.set(number, at); this.nativeHandlers.set(`fault.${name}`, at);
    }
    const records = this.instructions.map(() => this.frame());
    const resolve = (value: Value): BankValue => {
      if (!isLabel(value)) return value;
      const pc = this.labels.get(value.label);
      if (pc === undefined || !records[pc]) throw new Error(`unknown micro label ${value.label}`);
      return records[pc].pointer;
    };
    const arg = (value?: MicroRegister | MicroLabel): BankValue => value ? "frame" in value ? value.frame.pointer : resolve(value) : "0";
    this.instructions.forEach((inst, i) => {
      const handler = this.nativeHandlers.get(inst.op);
      if (!handler) throw new Error(`unimplemented micro operation ${inst.op}`);
      this.fill(records[i], [handler, arg(inst.a), arg(inst.b), inst.c ? arg(inst.c) : undefined, inst.d ? arg(inst.d) : undefined, records[i + 1]?.pointer ?? records[i].pointer]);
    });
    for (const patch of this.pending) this.layout.patch(patch.at, resolve(patch.value));
    this.nativeValues.set("$uPC", resolve(entryLabel));
    this.nativeValues.set("$next", this.nativeHandlers.get("setup")!);
    for (const [name, value] of this.nativeValues) this.layout.patch(this.layout.reg(name), value);
    return {
      patches: [...this.layout.patches.values()], entry: this.nativeHandlers.get("setup")!, next: this.next,
      faults: faultAddresses, microRecords: records, microLabels: new Map([...this.labels].map(([name, index]) => [name, records[index].pointer])),
      codeCells: [...this.layout.patches.values()].filter((p) => p.at.bank === 564).length,
    };
  }
}
