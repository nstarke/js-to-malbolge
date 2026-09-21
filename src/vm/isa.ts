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

/** Shared structural validation for execution, binary encoding, and native linking. */
export function validateBytecodeProgram(program: BytecodeProgram): void {
  wordModulus(program.width);
  if (!Number.isSafeInteger(program.localCount) || program.localCount < 0 || program.localCount > 1_000_000) {
    throw new RangeError("invalid local count");
  }
  // Validate every instruction, including unreachable instructions in hand-built programs.
  const code = program.instructions;
  for (const [pc, inst] of code.entries()) {
    if (inst.op === "push") {
      if (typeof inst.value !== "bigint") throw new TypeError(`pc ${pc}: push requires bigint`);
    } else if (inst.op === "load" || inst.op === "store") {
      if (!Number.isSafeInteger(inst.index) || inst.index < 0 || inst.index >= program.localCount) throw new RangeError(`pc ${pc}: invalid local index`);
    } else if (inst.op === "jump" || inst.op === "jz" || inst.op === "call") {
      if (!Number.isSafeInteger(inst.target) || inst.target < 0 || inst.target >= code.length) throw new RangeError(`pc ${pc}: invalid jump target`);
    } else if (!(SIMPLE_OPS as readonly string[]).includes(inst.op)) {
      throw new TypeError(`pc ${pc}: unknown opcode`);
    }
  }
}
