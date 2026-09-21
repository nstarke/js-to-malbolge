/** Logical instructions. Physical HeLL cell encoding is a separate backend. */
export const SIMPLE_OPS = [
  "add", "sub", "mul", "div", "mod", "eq", "lt", "le", "dup", "drop", "swap",
  "ret", "putc", "getc", "halt",
] as const;
export type SimpleOp = typeof SIMPLE_OPS[number];
export type Instruction =
  | { op: SimpleOp }
  | { op: "push"; value: bigint }
  | { op: "load" | "store"; index: number }
  | { op: "jump" | "jz" | "call"; target: number };

export interface BytecodeProgram {
  instructions: Instruction[];
  /** Fixed register width; arithmetic wraps in centered signed ternary. */
  width: number;
  localCount: number;
}

export function wordModulus(width: number): bigint {
  if (!Number.isSafeInteger(width) || width < 10 || width > 1024) {
    throw new RangeError("VM width must be an integer from 10 through 1024");
  }
  return 3n ** BigInt(width);
}

export function normalizeWord(value: bigint, modulus: bigint): bigint {
  const half = (modulus - 1n) / 2n;
  return ((value + half) % modulus + modulus) % modulus - half;
}
