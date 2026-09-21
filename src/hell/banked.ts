/** Internal bank-relative layout. Banks are resolved on the target, never by the host. */
import { fromNumber, type Trits } from "../malbolge/trits.js";
import { encryptValue, permanentNopValues, restorableValue, valueForOp } from "./cycles.js";
import type { BankWord } from "./bootstrap.js";
export type BankValue = BankWord | Trits;
export interface BankPatch { at: BankWord; value: BankValue }
export interface BankNative { op: "*" | "p" | "/" | "<"; register: string; indirect?: { capture: string } }
export const bankKey = (at: BankWord) => `${at.bank}:${at.offset}`;
const valueKey = (v: BankValue) => typeof v === "string" ? `t${v}` : bankKey(v);
const NOPS = Array.from({ length: 94 }, (_, r) => permanentNopValues(r).filter((v) => v <= 80));

export class BankLayout {
  readonly symbols = new Map<string, BankWord>();
  readonly patches = new Map<string, BankPatch>();
  private bank = 210;
  private codeOffset = 5;
  constructor(readonly next: BankWord, readonly one: BankWord) {
    this.symbols.set("$bank.one", one);
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
    const bank = options.bank ?? 376, entry = options.entry ?? this.codeOffset, start = entry + 1;
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
        while (inst.indirect ? j % 94 !== 64 : restorableValue("j", j) === null) j++;
        p = j + (options.seedPointers ? Math.max(1, dest.offset - 80) : 1); while (inst.indirect ? p % 94 !== 60 : restorableValue(inst.op, p) === null) p++;
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
      put(p, restorableValue(inst.indirect ? "j" : inst.op, p)!);
      previous = { c: p, at: dest }; c = p + 1;
      if (inst.indirect) {
        for (const [at, instruction] of [[p + 4, "j"], [p + 22, "p"], [p + 94, "j"], [p + 116, "p"]] as const) {
          for (; c < at; c++) put(c, NOPS[c % 94].includes(74) ? 74 : NOPS[c % 94][0]);
          put(at, restorableValue(instruction, at)!); c = at + 1;
        }
        previous = { c: p + 116, at: this.reg(inst.indirect.capture) };
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
    if (bank === 376) this.codeOffset = Math.ceil((c + 1 - 5) / 94) * 94 + 5;
    return { bank, offset: entry };
  }
}
