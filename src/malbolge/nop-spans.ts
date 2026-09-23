/** Lazy encryption of runs whose entire encryption cycles are no-ops. */
import { decodeOp, encrypt } from "./tables.js";
import { canon, fromNumber, modClass, next, type Trits } from "./trits.js";

/** Add a small nonnegative step count, including crossings from base 2 to 0. */
export function advanceAddress(value: Trits, count: number): Trits {
  let carry = count, i = 0, result = "";
  while (carry && i < value.length - 1) {
    const sum = value.charCodeAt(i++) - 48 + carry;
    result += sum % 3; carry = Math.floor(sum / 3);
  }
  if (!carry) return canon(result + value.slice(i));
  const leading = value.at(-1)!;
  if (leading !== "1") return canon(result + fromNumber(carry - (leading === "2" ? 1 : 0)));
  while (carry) { const sum = carry + 1; result += sum % 3; carry = Math.floor(sum / 3); }
  return canon(result + "1");
}

const WORDS = Array.from({ length: 127 }, (_, n) => fromNumber(n));
const CODES = new Map(WORDS.map((word, code) => [word, code]));
const CYCLES = WORDS.map((_, code) => {
  const cycle: Trits[] = [];
  if (code >= 33) {
    let value = code;
    do { cycle.push(WORDS[value]); value = encrypt(value); } while (value !== code);
  }
  return cycle;
});
const PERMANENT = Array.from({ length: 94 }, (_, residue) => CYCLES.map((cycle) =>
  cycle.length > 0 && cycle.every((word) => ["nop", "o"].includes(decodeOp(CODES.get(word)!, residue)))));

interface Span { addresses: Trits[]; cycles: Trits[][]; end: Trits; turns: number }

/** Sparse installed code only: caching a one-pass source stream would waste memory. */
export class NopSpans {
  private readonly starts = new Map<Trits, Span>();
  private readonly cells = new Map<Trits, { span: Span; index: number }>();
  skipped = 0;

  read(address: Trits): Trits | undefined {
    const entry = this.cells.get(address);
    if (!entry) return;
    const cycle = entry.span.cycles[entry.index];
    return cycle[entry.span.turns % cycle.length];
  }

  /** Any explicit write materializes the whole span before changing its cell. */
  invalidate(address: Trits, write: (address: Trits, value: Trits) => void): void {
    const entry = this.cells.get(address);
    if (!entry) return;
    const span = entry.span;
    this.starts.delete(span.addresses[0]);
    span.addresses.forEach((at, i) => {
      this.cells.delete(at);
      const cycle = span.cycles[i];
      write(at, cycle[span.turns % cycle.length]);
    });
  }

  run(c: Trits, d: Trits, remaining: number, sparse: Map<Trits, Trits>): { c: Trits; d: Trits; steps: number } | undefined {
    let span = this.starts.get(c);
    if (!span) {
      // Never overlap spans or cache implicit fill (which can be unbounded).
      if (this.cells.has(c)) return;
      const addresses: Trits[] = [], cycles: Trits[][] = [];
      let at = c;
      for (let i = 0; i < 256; i++) {
        if (this.cells.has(at)) break;
        const code = CODES.get(sparse.get(at)!);
        if (code === undefined || !PERMANENT[modClass(at) % 94][code]) break;
        addresses.push(at); cycles.push(CYCLES[code]); at = next(at);
      }
      if (addresses.length < 2) return;
      span = { addresses, cycles, end: at, turns: 0 };
      this.starts.set(c, span);
      addresses.forEach((address, index) => this.cells.set(address, { span: span!, index }));
    }
    const steps = span.addresses.length;
    if (steps > remaining) return;
    span.turns++; this.skipped += steps;
    return { c: span.end, d: advanceAddress(d, steps), steps };
  }
}
