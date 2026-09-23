/** Versioned portable bytecode. Native handler addresses never enter this format. */
import { normalizeWord, validateBytecodeProgram, wordModulus, type BytecodeProgram, type Instruction } from "./isa.js";

export const BYTECODE_VERSION = 1;
/** Explicit IDs are an ABI: do not reorder or reuse them. */
export const OPCODE_IDS = {
  halt: 0, push: 1, putc: 2, getc: 3, load: 4, store: 5,
  add: 6, sub: 7, mul: 8, div: 9, mod: 10, eq: 11, lt: 12, le: 13,
  dup: 14, drop: 15, swap: 16, jump: 17, jz: 18, call: 19, ret: 20, modi: 21, putci: 22, divi: 23,
} as const satisfies Record<Instruction["op"], number>;
const OPS = Object.keys(OPCODE_IDS) as Instruction["op"][];
const HEADER = 16;
const indexed = (op: string) => ["load", "store", "jump", "jz", "call"].includes(op);
const wordBytes = (width: number) => Math.ceil((wordModulus(width) - 1n).toString(2).length / 8);

export function encodeBytecode(program: BytecodeProgram): Uint8Array {
  validateBytecodeProgram(program);
  const bytes = wordBytes(program.width), modulus = wordModulus(program.width);
  const size = HEADER + program.instructions.reduce((n, inst) => n + 1 + ("value" in inst ? bytes : indexed(inst.op) ? 4 : 0), 0);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  out.set([0x4d, 0x42, 0x56, 0x4d, BYTECODE_VERSION, 0]); // MBVM, version, flags
  view.setUint16(6, program.width, true);
  view.setUint32(8, program.localCount, true);
  view.setUint32(12, program.instructions.length, true);
  let at = HEADER;
  for (const inst of program.instructions) {
    out[at++] = OPCODE_IDS[inst.op];
    if ("value" in inst) {
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
    const length = (op === "push" || op === "modi" || op === "divi" || op === "putci") ? bytes : indexed(op) ? 4 : 0;
    if (at + length > data.length) throw new SyntaxError(`pc ${pc}: truncated operand`);
    if (op === "push" || op === "modi" || op === "divi" || op === "putci") {
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

export interface DisassembleOptions {
  radix?: "decimal" | "hex" | "ternary";
  annotate?: boolean;
  /** Optional debug symbols; portable bytecode itself stores no names. */
  labels?: ReadonlyMap<number, string>;
}
export interface BytecodeInspection {
  format: "MBVM";
  version: number;
  width: number;
  localCount: number;
  byteLength: number;
  wordBytes: number;
  instructions: { pc: number; offset: number; size: number; opcode: number; op: Instruction["op"]; operand?: string | number; target?: number; label?: string; bytes: string }[];
}
function instructionLabels(program: BytecodeProgram, supplied?: ReadonlyMap<number, string>): Map<number, string> {
  const labels = new Map<number, string>(), names = new Set<string>();
  for (const [pc, name] of supplied ?? []) {
    if (!Number.isSafeInteger(pc) || pc < 0 || pc > program.instructions.length || typeof name !== "string" || !/^[A-Za-z_][\w.]*$/.test(name) || names.has(name)) throw new RangeError("invalid or duplicate disassembly label");
    labels.set(pc, name); names.add(name);
  }
  for (const inst of program.instructions) if ("target" in inst && !labels.has(inst.target)) {
    const base = `L${String(inst.target).padStart(4, "0")}`;
    let name = base, serial = 0;
    while (names.has(name)) name = `${base}_${++serial}`;
    labels.set(inst.target, name); names.add(name);
  }
  return labels;
}

/** JSON-safe structural inspection, with exact byte offsets and encoded bytes. */
export function inspectBytecode(input: BytecodeProgram | Uint8Array, options: Pick<DisassembleOptions, "labels"> = {}): BytecodeInspection {
  const program = input instanceof Uint8Array ? decodeBytecode(input) : input;
  validateBytecodeProgram(program);
  const encoded = input instanceof Uint8Array ? input : encodeBytecode(program);
  const labels = instructionLabels(program, options.labels), bytes = wordBytes(program.width), modulus = wordModulus(program.width);
  let offset = HEADER;
  const instructions = program.instructions.map((inst, pc) => {
    const size = 1 + ("value" in inst ? bytes : indexed(inst.op) ? 4 : 0);
    const result = { pc, offset, size, opcode: OPCODE_IDS[inst.op], op: inst.op,
      operand: "value" in inst ? normalizeWord(inst.value, modulus).toString() : "index" in inst ? inst.index : "target" in inst ? labels.get(inst.target) : undefined,
      target: "target" in inst ? inst.target : undefined, label: labels.get(pc),
      bytes: Array.from(encoded.subarray(offset, offset + size), (n) => n.toString(16).padStart(2, "0")).join(" "),
    };
    offset += size; return result;
  });
  return { format: "MBVM", version: BYTECODE_VERSION, width: program.width, localCount: program.localCount, byteLength: encoded.length, wordBytes: bytes, instructions };
}

/** Canonical, reassemblable output; optional annotations are assembly comments. */
export function disassembleBytecode(input: BytecodeProgram | Uint8Array, options: DisassembleOptions = {}): string {
  if (options.radix !== undefined && !["decimal", "hex", "ternary"].includes(options.radix)) throw new RangeError("invalid disassembly radix");
  const program = input instanceof Uint8Array ? decodeBytecode(input) : input;
  const inspection = inspectBytecode(program, options), labels = instructionLabels(program, options.labels);
  const format = (value: bigint) => {
    const sign = value < 0n ? "-" : "", magnitude = value < 0n ? -value : value;
    return options.radix === "hex" ? `${sign}0x${magnitude.toString(16)}` : options.radix === "ternary" ? `${sign}0t${magnitude.toString(3)}` : value.toString();
  };
  const lines = [`.width ${program.width}`, `.locals ${program.localCount}`, ""];
  for (const inst of inspection.instructions) {
    if (inst.label) lines.push(`${inst.label}:`);
    const immediate = "value" in program.instructions[inst.pc];
    const operand = inst.operand === undefined ? "" : ` ${immediate ? format(BigInt(inst.operand)) : inst.operand}`;
    const annotation = options.annotate ? ` # pc=${inst.pc} offset=0x${inst.offset.toString(16)} bytes=${inst.bytes}` : "";
    lines.push(`  ${inst.op}${operand}${annotation}`);
  }
  if (labels.has(program.instructions.length)) lines.push(`${labels.get(program.instructions.length)}:`);
  return lines.join("\n") + "\n";
}
