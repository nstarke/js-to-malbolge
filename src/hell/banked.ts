/** Internal bank-relative layout. Banks are resolved on the target, never by the host. */
import { fromNumber, type Trits } from "../malbolge/trits.js";
import { encryptValue, permanentNopValues, restorableValue, valueForOp } from "./cycles.js";
import type { BankWord } from "./bootstrap.js";
export type BankValue = BankWord | Trits;
export interface BankPatch { at: BankWord; value: BankValue }
export interface BankNative { op: "*" | "p" | "/" | "<"; register: string; indirect?: { capture: string; field?: number }; uninitialized?: { phase: number; capture: string } }
export const bankKey = (at: BankWord) => `${at.bank}:${at.offset}`;
const valueKey = (v: BankValue) => typeof v === "string" ? `t${v}` : bankKey(v);
const NOPS = Array.from({ length: 94 }, (_, r) => permanentNopValues(r).filter((v) => v <= 80));

export class BankLayout {
  readonly symbols = new Map<string, BankWord>();
  readonly patches = new Map<string, BankPatch>();
  private bank = 210;
  private codeOffset: number;
  constructor(readonly next: BankWord, readonly one: BankWord, readonly code: { bank: number; residue: number; entries02: boolean } = { bank: 376, residue: 5, entries02: false }) {
    this.symbols.set("$bank.one", one);
    this.codeOffset = code.residue;
  }
  reg(name: string): BankWord {
    const existing = this.symbols.get(name);
    if (existing) return existing;
    while ([282, 376, 470, 564, 650, 651, 652, 700, 701].includes(this.bank)) this.bank++;
    if (this.bank >= 640) throw new RangeError("banked runtime exceeds the register-bank limit");
    const at = { bank: this.bank++, offset: 80 }; this.symbols.set(name, at); return at;
  }
  patch(at: BankWord, value: BankValue): void {
    const prior = this.patches.get(bankKey(at));
    if (prior && valueKey(prior.value) !== valueKey(value)) throw new Error(`bank layout collision at ${bankKey(at)}`);
    this.patches.set(bankKey(at), { at, value });
  }
  /** Every restored block returns with D=NEXT+1, matching the bootstrap cycle. */
  block(body: BankNative[], options: { bank?: number; once?: boolean; entry?: number; seedPointers?: boolean } = {}): BankWord {
    const bank = options.bank ?? this.code.bank, entry = options.entry ?? this.codeOffset, start = entry + 1;
    const tailName = `$bank.tail.${bank}.${entry}`, tail = this.reg(tailName);
    this.symbols.set(tailName, tail);
    const instructions: BankNative[] = [{ op: "*", register: "$bank.one" }, ...body, { op: "*", register: tailName }];
    let c = start, previous: { c: number; at: BankWord } | undefined;
    const put = (offset: number, value: number) => this.patch({ bank, offset }, fromNumber(value));
    put(entry, 74);
    for (const inst of instructions) {
      const dest = this.reg(inst.register);
      let j = c, p = 0, pointer: BankWord;
      for (;;) {
        while ((inst.indirect || inst.uninitialized) ? j % 94 !== 64 : restorableValue("j", j) === null) j++;
        p = j + (options.seedPointers ? Math.max(1, dest.offset - 80) : 1); while (inst.uninitialized ? p % 94 !== 64 : inst.indirect ? p % 94 !== 60 : restorableValue(inst.op, p) === null) p++;
        pointer = { bank: dest.bank, offset: dest.offset - (p - j) };
        const field = previous ? { bank: previous.at.bank, offset: previous.at.offset + j - previous.c } :
          { bank: this.next.bank, offset: this.next.offset + 1 + j - start };
        const prior = this.patches.get(bankKey(field));
        if (pointer.offset > 0 && (!prior || valueKey(prior.value) === valueKey(pointer))) { this.patch(field, pointer); break; }
        j++;
      }
      for (; c < p; c++) put(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]);
      // Replace padding at the steering instruction.
      this.patches.set(bankKey({ bank, offset: j }), { at: { bank, offset: j }, value: fromNumber(restorableValue("j", j)!) });
      put(p, restorableValue(inst.indirect || inst.uninitialized ? "j" : inst.op, p)!);
      previous = { c: p, at: dest }; c = p + 1;
      if (inst.uninitialized) {
        // POINTER contains target-18. Return through untouched fill, without a
        // per-target capture pointer. The even fill route needs an extra hop.
        const { phase, capture } = inst.uninitialized;
        let ret = p + 94;
        const wanted = phase % 2 ? 3 : 2;
        while ((phase + ret - (p + 18)) % 6 !== wanted) ret += 94;
        const hops: [number, "j" | "p"][] = [[p + 18, "p"], [ret, "j"]];
        if (phase % 2 === 0) { ret += 188; hops.push([ret, "j"]); }
        // The fill hop yields 65, so the next j reads low cell 155. The linker
        // installs capture-22 there once for the whole decompressor.
        hops.push([ret + 90, "j"], [ret + 112, "p"]);
        for (const [at, instruction] of hops) {
          for (; c < at; c++) put(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]);
          put(at, restorableValue(instruction, at)!); c = at + 1;
        }
        previous = { c: ret + 112, at: this.reg(capture) };
      }
      if (inst.indirect) {
        const field = inst.indirect.field ?? 0;
        if (!Number.isSafeInteger(field) || field < 0) throw new RangeError("invalid indirect field");
        const shift = 94 * field;
        for (const [at, instruction] of [[p + 4, "j"], [p + 22 + shift, "p"], [p + 94 + shift, "j"], [p + 116 + shift, "p"]] as const) {
          for (; c < at; c++) put(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]);
          put(at, restorableValue(instruction, at)!); c = at + 1;
        }
        previous = { c: p + 116 + shift, at: this.reg(inst.indirect.capture) };
      }
    }
    while (c % 94 !== 60) { put(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]); c++; }
    const restoreJ = c;
    put(c++, options.once ? restorableValue("j", restoreJ)! : encryptValue(restorableValue("j", restoreJ)!));
    put(c, valueForOp("i", c));
    if (options.once) this.patch({ bank: tail.bank, offset: tail.offset + restoreJ - previous!.c }, { bank: this.next.bank, offset: this.next.offset - 1 });
    else {
      this.patch({ bank: tail.bank, offset: tail.offset + c - previous!.c }, { bank, offset: entry });
      this.patch({ bank: tail.bank, offset: tail.offset + c - previous!.c + 1 + restoreJ - start }, { bank: this.next.bank, offset: this.next.offset - 1 });
    }
    this.patch(tail, "0");
    if (bank === this.code.bank) {
      this.codeOffset = Math.ceil((c + 1 - this.code.residue) / 94) * 94 + this.code.residue;
      while (this.code.entries02 && /1/.test(this.codeOffset.toString(3))) this.codeOffset += 94;
    }
    return { bank, offset: entry };
  }
}
