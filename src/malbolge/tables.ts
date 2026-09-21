/**
 * Constant tables shared by the standard Malbolge and Malbolge Unshackled
 * interpreters. Values follow Ben Olmstead's public-domain reference
 * interpreter (1998) and Ørjan Johansen's Unshackled reference (2007).
 */

/** Decode table: `XLAT1[(cell - 33 + addr) % 94]` names the instruction. */
export const XLAT1 =
  "+b(29e*j1VMEKLyC})8&m#~W>qxdRp0wkrUo[D7,XTcA\"lI.v%{gJh4G\\-=O@5`_3i<?Z';FNQuY]szf$!BS/|t:Pn6^Ha";

/** Encryption table applied to the executed cell: `cell = XLAT2[cell - 33]`. */
export const XLAT2 =
  "5z]&gqtyfr$(we4{WP)H-Zn,[%\\3dL+Q;>U!pJS72FhOA1CB6v^=I_0/8|jsb9m<.TVac`uY*MK'X~xDl}REokN:#?G\"i@";

export type Trit = 0 | 1 | 2;

/** The crazy operation on single trits, indexed `CRAZY_TRIT[dTrit][aTrit]`. */
export const CRAZY_TRIT: readonly (readonly Trit[])[] = [
  [1, 0, 0],
  [1, 0, 2],
  [2, 2, 1],
];

/** Instruction mnemonics. `nop` is the runtime no-op for values not in the table. */
export type Mnemonic = "j" | "i" | "*" | "p" | "<" | "/" | "v" | "o" | "nop";

/** Map from `(cell + addr) % 94` to the instruction it selects. */
export const OPCODES: Readonly<Record<number, Mnemonic>> = {
  4: "i", // jmp: C = [D]
  5: "<", // out: print A
  23: "/", // in: A = read
  39: "*", // rotr: A = [D] = rotr([D])
  40: "j", // movd: D = [D]
  62: "p", // crazy: A = [D] = crazy(A, [D])
  68: "o", // nop
  81: "v", // halt
};

export function decodeOp(cell: number, addrMod94: number): Mnemonic {
  return OPCODES[(cell + addrMod94) % 94] ?? "nop";
}

/** True if `cell` (33..126) at address `addr` is a legal source instruction. */
export function isValidSourceInstruction(cell: number, addr: number): boolean {
  if (cell < 33 || cell > 126) return false;
  return decodeOp(cell, addr % 94) !== "nop";
}

export function encrypt(cell: number): number {
  return XLAT2.charCodeAt(cell - 33);
}

export const WORD_MAX = 59048; // 3^10 - 1
export const MEM_SIZE = 59049;

/** Crazy operation on two 10-trit words. */
export function crazy10(a: number, d: number): number {
  let result = 0;
  let p = 1;
  for (let i = 0; i < 10; i++) {
    const ta = a % 3;
    const td = d % 3;
    result += CRAZY_TRIT[td][ta] * p;
    a = (a - ta) / 3;
    d = (d - td) / 3;
    p *= 3;
  }
  return result;
}

/** Rotate a 10-trit word right by one trit. */
export function rotr10(x: number): number {
  return Math.floor(x / 3) + (x % 3) * 19683;
}
