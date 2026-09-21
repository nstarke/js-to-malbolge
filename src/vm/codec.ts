/** Versioned portable bytecode. Native handler addresses never enter this format. */
import { normalizeWord, validateBytecodeProgram, wordModulus, type BytecodeProgram, type Instruction } from "./isa.js";

export const BYTECODE_VERSION = 1;
/** Explicit IDs are an ABI: do not reorder or reuse them. */
export const OPCODE_IDS = {
  halt: 0, push: 1, putc: 2, getc: 3, load: 4, store: 5,
  add: 6, sub: 7, mul: 8, div: 9, mod: 10, eq: 11, lt: 12, le: 13,
  dup: 14, drop: 15, swap: 16, jump: 17, jz: 18, call: 19, ret: 20,
} as const satisfies Record<Instruction["op"], number>;
const OPS = Object.keys(OPCODE_IDS) as Instruction["op"][];
const HEADER = 16;
const indexed = (op: string) => ["load", "store", "jump", "jz", "call"].includes(op);
const wordBytes = (width: number) => Math.ceil((wordModulus(width) - 1n).toString(2).length / 8);

export function encodeBytecode(program: BytecodeProgram): Uint8Array {
  validateBytecodeProgram(program);
  const bytes = wordBytes(program.width), modulus = wordModulus(program.width);
  const size = HEADER + program.instructions.reduce((n, inst) => n + 1 + (inst.op === "push" ? bytes : indexed(inst.op) ? 4 : 0), 0);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  out.set([0x4d, 0x42, 0x56, 0x4d, BYTECODE_VERSION, 0]); // MBVM, version, flags
  view.setUint16(6, program.width, true);
  view.setUint32(8, program.localCount, true);
  view.setUint32(12, program.instructions.length, true);
  let at = HEADER;
  for (const inst of program.instructions) {
    out[at++] = OPCODE_IDS[inst.op];
    if (inst.op === "push") {
      let value = (inst.value % modulus + modulus) % modulus;
      for (let i = 0; i < bytes; i++) { out[at++] = Number(value & 255n); value >>= 8n; }
    } else if ("index" in inst || "target" in inst) {
      view.setUint32(at, "index" in inst ? inst.index : inst.target, true); at += 4;
    }
  }
  return out;
}

export function decodeBytecode(data: Uint8Array): BytecodeProgram {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < HEADER) throw new SyntaxError("truncated bytecode header");
  if ([0x4d, 0x42, 0x56, 0x4d].some((v, i) => data[i] !== v)) throw new SyntaxError("invalid bytecode magic");
  if (data[4] !== BYTECODE_VERSION) throw new SyntaxError(`unsupported bytecode version ${data[4]}`);
  if (data[5] !== 0) throw new SyntaxError("unsupported bytecode flags");
  const width = view.getUint16(6, true), localCount = view.getUint32(8, true), count = view.getUint32(12, true);
  const bytes = wordBytes(width), modulus = wordModulus(width);
  if (count > data.length - HEADER) throw new SyntaxError("truncated instruction stream");
  const instructions: Instruction[] = [];
  let at = HEADER;
  for (let pc = 0; pc < count; pc++) {
    if (at >= data.length) throw new SyntaxError(`pc ${pc}: truncated opcode`);
    const id = data[at++], op = OPS.find((op) => OPCODE_IDS[op] === id);
    if (!op) throw new SyntaxError(`pc ${pc}: unknown opcode ${id}`);
    const length = op === "push" ? bytes : indexed(op) ? 4 : 0;
    if (at + length > data.length) throw new SyntaxError(`pc ${pc}: truncated operand`);
    if (op === "push") {
      let value = 0n;
      for (let i = bytes - 1; i >= 0; i--) value = value << 8n | BigInt(data[at + i]);
      if (value >= modulus) throw new SyntaxError(`pc ${pc}: noncanonical word`);
      instructions.push({ op, value: normalizeWord(value, modulus) });
    } else if (op === "load" || op === "store") instructions.push({ op, index: view.getUint32(at, true) });
    else if (op === "jump" || op === "jz" || op === "call") instructions.push({ op, target: view.getUint32(at, true) });
    else instructions.push({ op });
    at += length;
  }
  if (at !== data.length) throw new SyntaxError("trailing bytecode data");
  const program = { width, localCount, instructions };
  validateBytecodeProgram(program);
  return program;
}

/** Canonical assembly with metadata and symbolic instruction-index labels. */
export function disassembleBytecode(input: BytecodeProgram | Uint8Array): string {
  const program = input instanceof Uint8Array ? decodeBytecode(input) : input;
  validateBytecodeProgram(program);
  const targets = new Set(program.instructions.flatMap((inst) => "target" in inst ? [inst.target] : []));
  const label = (pc: number) => `L${String(pc).padStart(4, "0")}`;
  const lines = [`.width ${program.width}`, `.locals ${program.localCount}`, ""];
  const modulus = wordModulus(program.width);
  for (const [pc, inst] of program.instructions.entries()) {
    if (targets.has(pc)) lines.push(`${label(pc)}:`);
    const operand = inst.op === "push" ? ` ${normalizeWord(inst.value, modulus)}` :
      "index" in inst ? ` ${inst.index}` : "target" in inst ? ` ${label(inst.target)}` : "";
    lines.push(`  ${inst.op}${operand}`);
  }
  return lines.join("\n") + "\n";
}
