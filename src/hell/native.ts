/** Internal native operations shared by register loops and the bytecode VM. */
import { BankLayout, type BankNative, type BankValue } from "./banked.js";

/** Shared native operations. Reads use masks, never a guessed full rotation. */
export class NativeBuilder {
  body: BankNative[] = [];
  /** Optional immutable S(MAX), initialized by the caller, and a finite zero. */
  readMask?: { mask: string; zero: string };
  /** Registers whose live values contain only 0/2 trits. */
  readonly words02 = new Set<string>();
  compactResets = false;
  private onesAt?: number;
  private onesBody?: BankNative[];
  constructor(readonly layout: BankLayout, readonly values: Map<string, BankValue>) {}
  reg(name: string, value: BankValue = "0"): string {
    this.layout.reg(name); if (!this.values.has(name)) this.values.set(name, value);
    // Immutable constants containing only 0/2 trits have a one-operation read.
    // Mutable registers must be classified explicitly by their caller.
    if (name.startsWith("$constant.") || name.startsWith("$native.constant.")) {
      if (typeof value === "string" ? !value.includes("1") : !value.bank.toString(3).includes("1") && !value.offset.toString(3).includes("1")) this.words02.add(name);
    }
    return name;
  }
  emit(op: BankNative["op"], register: string, count = 1): void {
    for (let i = 0; i < count; i++) this.body.push({ op, register });
  }
  ones(): void {
    if (this.compactResets && this.onesBody === this.body && this.onesAt === this.body.length) return;
    this.emit("*", "$bank.one"); this.onesAt = this.body.length; this.onesBody = this.body;
  }
  reset(dest: string, zero = false): void {
    this.ones(); this.emit("p", dest, zero ? 3 : 2);
    this.onesAt = zero ? undefined : this.body.length; this.onesBody = this.body;
  }
  read02(src: string): void { this.ones(); this.emit("p", src); }
  mask(): void {
    if (this.readMask) {
      // S(MAX) has only 1/2 trits, so A=0 reads it without modifying it.
      this.ones(); this.emit("p", this.readMask.zero); this.emit("p", this.readMask.mask);
    } else { this.reset("$mask"); this.read02("$max"); this.emit("p", "$mask"); }
  }
  read(src: string, base = 0): void {
    if (src === "$bank.one") { this.ones(); return; }
    if (src === "$max" || this.words02.has(src)) { this.read02(src); return; }
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
