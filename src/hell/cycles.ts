/**
 * Facts about the encryption permutation (xlat2) needed for code generation:
 * which values stay nops forever at a given address, and which values
 * alternate between an instruction and a nop ("restorable" cells).
 */
import { OPCODES, XLAT2, decodeOp, type Mnemonic } from "../malbolge/tables.js";

export type Op = "j" | "i" | "*" | "p" | "<" | "/" | "v" | "o";

const OPCODE_OF: Record<Op, number> = { i: 4, "<": 5, "/": 23, "*": 39, j: 40, p: 62, o: 68, v: 81 };

export function encryptValue(v: number): number {
  return XLAT2.charCodeAt(v - 33);
}

/** The xlat2 cycle containing v, starting at v. */
export function cycleOf(v: number): number[] {
  const out = [v];
  let x = encryptValue(v);
  while (x !== v) {
    out.push(x);
    x = encryptValue(x);
  }
  return out;
}

/** The unique value in 33..126 that executes `op` at address `addr`. */
export function valueForOp(op: Op, addr: number): number {
  const want = OPCODE_OF[op];
  const v = (((want - (addr % 94)) % 94) + 94) % 94;
  return v < 33 ? v + 94 : v;
}

export function isNop(v: number, addr: number): boolean {
  const m = decodeOp(v, addr % 94);
  return m === "nop" || m === "o";
}

/** True if v at addr is a legal source character (decodes to a real instruction). */
export function isValidAt(v: number, addr: number): boolean {
  return v >= 33 && v <= 126 && OPCODES[(v + (addr % 94)) % 94] !== undefined;
}

/**
 * The `o` instruction value at `addr` if it stays a nop on every later
 * execution (its whole encryption cycle decodes to nop there), else null.
 * Only such cells may be executed repeatedly as padding.
 */
export function permanentO(addr: number): number | null {
  const v = valueForOp("o", addr);
  return cycleOf(v).every((x) => isNop(x, addr)) ? v : null;
}

/** Residues mod 94 where a permanent `o` exists. */
export function permanentOResidues(): number[] {
  const out: number[] = [];
  for (let r = 0; r < 94; r++) if (permanentO(r) !== null) out.push(r);
  return out;
}

/** A filler value for a cell that is never executed: the `o` instruction. */
export function fillerValue(addr: number): number {
  return valueForOp("o", addr);
}

/** All legal source values at `addr` (exactly eight). */
export function validValues(addr: number): number[] {
  const out: number[] = [];
  for (let v = 33; v <= 126; v++) if (isValidAt(v, addr)) out.push(v);
  return out;
}

/** The two-cycle F <-> J is the only length-2 cycle of xlat2. */
export const RESTORABLE_PAIR = [70, 74] as const;

/**
 * If a cell at `addr` can alternate `op`, nop, `op`, nop, ... starting with
 * `op`, return the value to place there; otherwise null.
 */
export function restorableValue(op: Exclude<Op, "i" | "o">, addr: number): number | null {
  for (const v of RESTORABLE_PAIR) {
    const other = encryptValue(v);
    if (decodeOp(v, addr % 94) === (op as Mnemonic) && isNop(other, addr)) return v;
  }
  return null;
}

/** Address residues mod 94 at which `op` has a restorable cell. */
export function restorableResidues(op: Exclude<Op, "i" | "o">): number[] {
  const out: number[] = [];
  for (let r = 0; r < 94; r++) if (restorableValue(op, r) !== null) out.push(r);
  return out;
}

/** All values 33..126 whose whole encryption cycle decodes to nop at `addr` (not legal in source). */
export function permanentNopValues(addr: number): number[] {
  const out: number[] = [];
  for (let v = 33; v <= 126; v++) if (cycleOf(v).every((x) => isNop(x, addr))) out.push(v);
  return out;
}
