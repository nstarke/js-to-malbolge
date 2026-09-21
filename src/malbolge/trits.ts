/**
 * Unbounded ternary values for Malbolge Unshackled.
 *
 * A value is a string of '0'/'1'/'2' characters, least significant trit
 * first. The last character is the "base" trit, which repeats infinitely to
 * the left (3-adic integers). Strings are kept canonical: the last two
 * characters never match, so every value has exactly one representation and
 * strings can be used directly as Map keys.
 *
 *   "0"    = 0            "10"   = 1          "20" = 2
 *   "2"    = ...222 = -1  "12"   = ...221 = -2
 *   "1"    = ...111       (not an integer; a legal Malbolge value anyway)
 */
import { CRAZY_TRIT, type Trit } from "./tables.js";

export type Trits = string;

export const ZERO: Trits = "0";
export const MINUS_ONE: Trits = "2"; // ...222, Unshackled EOF marker
export const EOL: Trits = "12"; // ...221, Unshackled newline marker

const MOD_CLASS = 282; // lcm(6, 94)
const BASE_CLASS = [0, 29524 % MOD_CLASS, (2 * 29524) % MOD_CLASS];

export function canon(s: string): Trits {
  let n = s.length;
  while (n >= 2 && s.charCodeAt(n - 1) === s.charCodeAt(n - 2)) n--;
  return n === s.length ? s : s.slice(0, n);
}

export function base(v: Trits): Trit {
  return (v.charCodeAt(v.length - 1) - 48) as Trit;
}

/** Number of trits before the repeating base trit. */
export function width(v: Trits): number {
  return v.length - 1;
}

export function tritAt(v: Trits, i: number): Trit {
  return (v.charCodeAt(i < v.length ? i : v.length - 1) - 48) as Trit;
}

/** Offset from the base pattern: sum of (trit_i - base) * 3^i. */
export function offsetBig(v: Trits): bigint {
  const b = BigInt(base(v));
  let acc = 0n;
  for (let i = v.length - 2; i >= 0; i--) {
    acc = acc * 3n + (BigInt(v.charCodeAt(i) - 48) - b);
  }
  return acc;
}

/** Offset as a JS number, or null if it may not be exactly representable. */
export function offsetNumber(v: Trits): number | null {
  if (v.length > 34) return null; // 3^33 < 2^53
  const b = v.charCodeAt(v.length - 1) - 48;
  let acc = 0;
  for (let i = v.length - 2; i >= 0; i--) {
    acc = acc * 3 + (v.charCodeAt(i) - 48 - b);
  }
  return acc;
}

/** Integer value, or null for base-1 values (...111 is not an integer). */
export function toBigInt(v: Trits): bigint | null {
  const b = base(v);
  if (b === 1) return null;
  const off = offsetBig(v);
  return b === 0 ? off : off - 1n;
}

export function fromBigInt(n: bigint): Trits {
  let b: bigint;
  let o: bigint;
  if (n >= 0n) {
    b = 0n;
    o = n;
  } else {
    b = 2n;
    o = n + 1n;
  }
  let out = "";
  while (o !== 0n) {
    const q = o + b;
    let m = q % 3n;
    if (m < 0n) m += 3n;
    out += String(m);
    o = (q - m) / 3n;
  }
  return out + String(b);
}

export function fromNumber(n: number): Trits {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${n}`);
  return fromBigInt(BigInt(n));
}

/** Build a value from a base trit and an offset. */
export function fromOffset(b: Trit, offset: bigint): Trits {
  const bb = BigInt(b);
  let out = "";
  let o = offset;
  while (o !== 0n) {
    const q = o + bb;
    let m = q % 3n;
    if (m < 0n) m += 3n;
    out += String(m);
    o = (q - m) / 3n;
  }
  return out + String(b);
}

/** Tritwise crazy operation, `crazy(a, d)`. */
export function crazy(a: Trits, d: Trits): Trits {
  const n = Math.max(a.length, d.length);
  const ba = a.charCodeAt(a.length - 1) - 48;
  const bd = d.charCodeAt(d.length - 1) - 48;
  let out = "";
  for (let i = 0; i < n; i++) {
    const ta = i < a.length ? a.charCodeAt(i) - 48 : ba;
    const td = i < d.length ? d.charCodeAt(i) - 48 : bd;
    out += CRAZY_TRIT[td][ta];
  }
  return canon(out);
}

/**
 * Rotate right by one trit within the low `w` trits; trits at positions
 * >= w are unchanged. Matches the Unshackled reference `rotate`.
 */
export function rotate(v: Trits, w: number): Trits {
  if (w < 1) throw new RangeError("rotation width must be positive");
  const t = v[0];
  const r = v.length === 1 ? v : v.slice(1);
  const b = r[r.length - 1];
  let out: string;
  if (w - 1 <= r.length) {
    out = r.slice(0, w - 1);
  } else {
    out = r + b.repeat(w - 1 - r.length);
  }
  out += t;
  out += w - 1 < r.length ? r.slice(w - 1) : b;
  return canon(out);
}

/** The successor value (address + 1). */
export function next(v: Trits): Trits {
  const n = v.length;
  const b = v.charCodeAt(n - 1) - 48;
  let zeros = 0;
  for (let i = 0; i < n - 1; i++) {
    const t = v.charCodeAt(i) - 48;
    if (t < 2) {
      return canon("0".repeat(zeros) + (t + 1) + v.slice(i + 1));
    }
    zeros++;
  }
  if (b === 0) return "0".repeat(zeros) + "10";
  if (b === 1) return "0".repeat(zeros) + "21";
  return ZERO; // ...222 + 1 = 0
}

/** `(base * 29524 + offset) mod 282`, the address class used for memory fill and decoding. */
export function modClass(v: Trits): number {
  const b = v.charCodeAt(v.length - 1) - 48;
  let acc = 0;
  for (let i = v.length - 2; i >= 0; i--) {
    acc = (acc * 3 + (v.charCodeAt(i) - 48 - b) + MOD_CLASS) % MOD_CLASS;
  }
  return (BASE_CLASS[b] + acc) % MOD_CLASS;
}

/** Human-readable form: e.g. "...0t2101" or "...2t" for -1. */
export function format(v: Trits): string {
  const b = v[v.length - 1];
  const digits = v.slice(0, -1).split("").reverse().join("");
  return `...${b}t${digits}`;
}
