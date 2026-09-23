/** Native run decoder for dense code padding; no host-side memory injection. */
import { MicroBuilder, type MicroRegister } from "./micro.js";
import type { BankWord, BootstrapPatch } from "../hell/bootstrap.js";
import { crazy, fromNumber, type Trits } from "../malbolge/trits.js";
import { bankKey } from "../hell/banked.js";

export interface PaddingInstaller {
  patches: BootstrapPatch[];
  entry: BankWord;
  next: BankWord;
  resume: BankWord;
  fill: { bank: number; start: number; end: number; value: Trits };
}

export function planPaddingInstaller(application: { patches: BootstrapPatch[]; next: BankWord }, range?: { start: number; end: number }): PaddingInstaller | undefined {
  const code = application.patches.filter((p) => p.at.bank === 564);
  if (!range && code.length < 200_000) return;
  const start = range?.start ?? 18, end = range?.end ?? code.reduce((max, p) => Math.max(max, p.at.offset), 0) + 1;
  if (start !== 18 || end <= start || end >= 3 ** 30) throw new RangeError("invalid padding range");
  const b = new MicroBuilder(31), maxOffset = 3 ** 31 - 1;
  const fullMask = b.constant({ bank: 728, offset: maxOffset });
  const pointer = b.reg("loader.pointer", { bank: 564, offset: start - 18 });
  const digits = Math.ceil(Math.log(end - start + 1) / Math.log(3));
  const returns = Array.from({ length: digits }, (_, i) => b.reg(`loader.return.${i}`));
  const masks = Array.from({ length: digits }, (_, i) => [
    b.constant({ bank: 728, offset: maxOffset - 2 * 3 ** i }),
    b.constant({ bank: 728, offset: maxOffset - 3 ** i }),
  ]);
  // A radix-three traversal knows the digit it changes. No arithmetic counter,
  // digit extraction, or comparison is needed on the target.
  const change = (position: number, wrap = false) => {
    b.emit("padstep", pointer, masks[position][wrap ? 0 : 1]);
  };
  const call = (position: number, parity: number) => {
    const resume = b.unique("loader.resume"); b.set(returns[position], resume);
    b.jump(b.label(`loader.tree.${position}.${parity}`)); b.mark(resume);
  };
  b.mark(b.label("loader.entry"));
  let offset = 0, left = end - start;
  for (let k = digits - 1; k >= 0; k--) {
    const block = 3 ** k, count = Math.floor(left / block);
    for (let i = 0; i < count; i++) {
      if (k === 0) b.emit(`fill${(start + offset) % 6}`, pointer);
      else call(k - 1, offset % 2);
      change(k); offset += block;
    }
    left %= block;
  }
  b.emit("sourceReturn");
  for (let k = 0; k < digits - 1; k++) for (let parity = 0; parity < 2; parity++) {
    b.mark(b.label(`loader.tree.${k}.${parity}`));
    for (let i = 0; i < 3; i++) {
      if (k === 0) b.emit(`fill${(start + 3 * parity + i) % 6}`, pointer);
      else call(k - 1, (parity + i) % 2);
      if (i < 2) change(k);
    }
    change(k, true); b.ijump(returns[k]);
  }
  b.nativeExtension = ({ n, read, block, advance }) => {
    // Fixed suffix >& produces these untouched fill words. The first operand
    // maps any original trit to 1; the second maps those ones to 74.
    const fill = ["22021", "20110", "12021", "20120", "2201", "10120"];
    const preimage = crazy(fromNumber(74), "1");
    n.reg("$loader.preimage", preimage);
    n.reg("$loader.resume"); n.reg("$loader.low-return", fromNumber(38));
    n.reg("$loader.source-d"); b.layout.symbols.set("$loader.source-d", { ...b.next, offset: b.next.offset + 1 });
    for (let i = 0; i < 6; i++) {
      const operand = Array.from(fill[i], (digit) => digit === "2" ? "2" : "0").join("").replace(/0+$/, "") + "0";
      n.reg(`$loader.mask${i}`, operand);
      block(`fill${i}`, () => {
        read("$pointer", "$address", 0, "word");
        const indirect = () => n.body.push({ op: "p", register: "$pointer", uninitialized: { phase: i, capture: "$capture" } });
        n.read(`$loader.mask${i}`); indirect();
        n.read("$loader.preimage", 1); indirect(); advance();
      });
    }
    n.reg("$loader.step-mask");
    block("padstep", () => {
      // Build an infinite-base-1 mask from its finite preimage. Outside the
      // selected trit, two crazy operations are the identity; outside the bank
      // window the second operand restores the finite zero tail directly.
      read("$value", "$dest", 0, "word"); n.reset("$loader.step-mask");
      n.read("$value"); n.emit("p", "$loader.step-mask");
      read("$value", "$address", 0, "word"); n.read02("$max"); n.emit("p", "$value");
      n.read("$loader.step-mask", 1); n.emit("p", "$value");
      n.copy("$dest", "$address"); n.copy("$next", "$native.target.write");
    });
    block("sourceReturn", () => {
      n.copy("$loader.source-d", "$loader.low-return"); n.copy("$next", "$loader.resume");
    }, true);
  };
  const plan = b.finish(b.label("loader.entry"), {});
  // The decompressor coexists with the bootstrap, and runs before application
  // registers/data are installed. Keep its code and data out of application banks.
  const remap = (at: BankWord): BankWord => ({ bank: at.bank === 564 ? 282 : at.bank === 700 ? 701 : at.bank === 728 ? 726 : at.bank, offset: at.offset });
  const patches = plan.patches.map((p) => ({ at: remap(p.at), value: typeof p.value === "string" ? p.value : remap(p.value) }));
  // These are external addresses/masks, not references into the loader's layout.
  const external = (reg: MicroRegister, value: BankWord) => {
    const at = remap(reg.frame.fields[0]), patch = patches.find((p) => bankKey(p.at) === bankKey(at))!;
    patch.value = value;
  };
  external(pointer, { bank: 564, offset: start - 18 });
  external(fullMask, { bank: 728, offset: maxOffset });
  masks.forEach((row, i) => row.forEach((reg, field) => external(reg, { bank: 728, offset: maxOffset - (2 - field) * 3 ** i })));
  // Native read masks include the entire bank coefficient window as well.
  const nativeMax = remap(b.layout.reg("$max"));
  patches.find((p) => bankKey(p.at) === bankKey(nativeMax))!.value = { bank: 728, offset: maxOffset };
  patches.push({ at: { bank: 0, offset: 155 }, value: { ...b.layout.reg("$capture"), offset: b.layout.reg("$capture").offset - 22 } });
  return { patches, entry: remap(plan.entry), next: remap(plan.next), resume: remap(b.layout.reg("$loader.resume")), fill: { bank: 564, start, end, value: fromNumber(74) } };
}
