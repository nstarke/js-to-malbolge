/** A direct-threaded bytecode interpreter with shared native opcode handlers. */
import { BankLayout, type BankValue } from "../hell/banked.js";
import { bootstrapCycleImage, installBootstrap, type BankWord } from "../hell/bootstrap.js";
import { valueForOp } from "../hell/cycles.js";
import { fixedWord } from "../hell/init.js";
import { NativeBuilder } from "../hell/native.js";
import { fromNumber } from "../malbolge/trits.js";
import { decodeBytecode, encodeBytecode, OPCODE_IDS } from "./codec.js";
import { normalizeWord, wordModulus, type BytecodeProgram } from "./isa.js";
import { planFullHeLLVM } from "./full.js";
import { HELL_VM_FAULTS } from "./faults.js";
export { HELL_VM_FAULTS } from "./faults.js";

export interface HeLLVMOptions {
  /** Maximum live data stack depth. Defaults to 16. */
  stackCapacity?: number;
  /** Maximum live bytecode call depth. Defaults to 16. */
  returnStackCapacity?: number;
  maxSourceCells?: number;
}
const VALUE_BANK = 700, PROXY_BANK = 728, CODE_BANK = 564, FRAME_STRIDE = 752;
const NEXT: BankWord = { bank: 650, offset: 80 };
const HALT: BankWord = { bank: 188, offset: 2 };
/** Enumerate finite words containing only 0/2 trits. */
const pointerOffset = (index: number) => parseInt((index + 1).toString(2).replace(/1/g, "2"), 3);

export interface VMFrame {
  pointer: BankWord;
  fields: BankWord[];
}

/**
 * Decode portable bytecode and relocate its data into a fixed native interpreter.
 * Literal-only programs use compact boxes; other programs use shared microcode.
 */
export function planHeLLVM(input: BytecodeProgram | Uint8Array, options: HeLLVMOptions = {}) {
  const bytecode = input instanceof Uint8Array ? input.slice() : encodeBytecode(input);
  const program = decodeBytecode(bytecode);
  fixedWord(0, program.width);
  if (program.localCount || program.instructions.some((inst) => !["push", "putc", "halt"].includes(inst.op))) return planFullHeLLVM(program, options);
  if (options.returnStackCapacity !== undefined && (!Number.isSafeInteger(options.returnStackCapacity) || options.returnStackCapacity < 0 || options.returnStackCapacity > 1_000_000)) throw new RangeError("invalid VM stack capacity");
  const capacity = options.stackCapacity ?? 16;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 1_000_000) throw new RangeError("invalid VM stack capacity");
  const cycle = bootstrapCycleImage(59, true);
  const layout = new BankLayout(NEXT, cycle.symbols.get("one.0")!, { bank: CODE_BANK, residue: 2, entries02: true });
  layout.symbols.set("$next", NEXT);
  const values = new Map<string, BankValue>(), n = new NativeBuilder(layout, values);
  n.compactResets = true;
  for (const name of ["$mask", "$max", "$copy", "$pointer", "$capture", "$storevalue", "$save", "$readmask", "$zero", "$result", "pc", "sp", "candidate", "value", "literal"]) n.reg(name);
  layout.symbols.set("$pointer", { ...layout.reg("$pointer"), offset: 180 });
  for (const name of ["pc", "sp", "candidate", "literal"]) {
    layout.symbols.set(name, { ...layout.reg(name), offset: 180 });
    n.words02.add(name);
  }
  n.words02.add("$empty");
  values.set("$max", { bank: 728, offset: 3 ** 31 - 1 });

  const target = (name: string) => { const reg = n.reg(`$handler.${name}`); n.words02.add(reg); return reg; };
  const indirect = (field: number, pointer = "$pointer") => n.body.push({ op: "p", register: pointer, indirect: { capture: "$capture", field } });
  const read = (dest: string, pointer: string, field: number, word02 = true) => {
    const out = dest === pointer ? "$result" : dest;
    n.reset(out);
    for (let i = 0; i < (word02 ? 1 : 2); i++) {
      n.reset("$capture"); if (word02) n.ones(); else n.mask(); indirect(field, pointer);
    }
    n.emit("p", out);
    if (dest === pointer) { if (word02) n.words02.add("$result"); n.copy(dest, out); n.words02.delete("$result"); }
  };
  const write = (pointer: string, field: number, source: string) => {
    n.copy("$pointer", pointer); n.copy("$storevalue", source);
    n.reset("$save"); n.reset("$capture"); n.ones(); indirect(field); n.emit("p", "$save"); indirect(field);
    n.reset("$save"); n.read("$storevalue"); n.emit("p", "$save"); indirect(field);
  };
  const handlers = new Map<string, BankWord>([["halt", HALT]]);
  const faults = new Map<number, BankWord>();
  for (const [name, code] of Object.entries(HELL_VM_FAULTS)) {
    if (code > HELL_VM_FAULTS.fellOffProgram) continue;
    const at = { bank: HALT.bank, offset: pointerOffset(code) };
    handlers.set(code === 0 ? "halt" : name, at); faults.set(code, at);
    layout.patch(at, fromNumber(74));
    layout.patch({ ...at, offset: at.offset + 1 }, fromNumber(valueForOp("v", at.offset + 1)));
  }
  const block = (name: string, emit: () => void) => {
    emit(); handlers.set(name, layout.block(n.body)); n.body = [];
  };
  const advance = () => { read("pc", "pc", 2); n.copy("$next", target("fetch")); };
  block("setup", () => {
    n.reset("$readmask"); n.read02("$max"); n.emit("p", "$readmask");
    n.copy("$next", target("fetch"));
  });
  n.readMask = { mask: "$readmask", zero: "$zero" };
  block("fetch", () => read("$next", "pc", 0));
  block("push", () => {
    if (capacity === 1) read("$next", "sp", 4);
    else {
      read("candidate", "sp", 2); // next stack frame
      read("$next", "candidate", 3); // capacity guard, stored in the frame
    }
  });
  block("push-write", () => {
    // Literals are immutable boxes. The stack stores their record pointers.
    if (capacity === 1) n.copy("sp", "pc");
    else { write("candidate", 0, "pc"); n.copy("sp", "candidate"); }
    advance();
  });
  block("putc", () => {
    if (capacity === 1) read("$next", "sp", 3);
    else { read("literal", "sp", 0); read("$next", "literal", 3); }
  });
  block("putc-write", () => {
    read("value", capacity === 1 ? "sp" : "literal", 1, false); n.read("value"); n.emit("<", "value");
    if (capacity === 1) n.copy("sp", n.reg("$empty"));
    else read("sp", "sp", 1);
    advance();
  });
  for (const [name, at] of handlers) values.set(target(name), at);
  const entry = handlers.get("setup")!;
  values.set("$next", entry);

  // Each record has six fields, separated by 94 cells so indirect operations
  // keep their restorable instruction residues while selecting a field.
  let frameCount = 0;
  const frame = (): VMFrame => {
    const row = frameCount++;
    return {
      pointer: { bank: PROXY_BANK, offset: pointerOffset(row) },
      fields: Array.from({ length: 6 }, (_, field) => ({ bank: VALUE_BANK, offset: 80 + FRAME_STRIDE * row + 94 * field })),
    };
  };
  const records = Array.from({ length: program.instructions.length + 1 }, frame);
  const empty = frame();
  const stack = Array.from({ length: capacity === 1 ? 0 : capacity + 2 }, frame); // empty and overflow sentinels
  const installFrame = (f: VMFrame, contents: BankValue[]) => {
    layout.patch({ bank: f.pointer.bank, offset: f.pointer.offset + 4 }, { ...f.fields[0], offset: f.fields[0].offset - 18 });
    for (const [field, at] of f.fields.entries()) {
      layout.patch(at, contents[field] ?? "0");
      const capture = layout.reg("$capture");
      layout.patch({ ...at, offset: at.offset + 72 }, { ...capture, offset: capture.offset - 22 });
    }
  };
  const modulus = wordModulus(program.width);
  for (const [pc, inst] of program.instructions.entries()) {
    const value = inst.op === "push" ? normalizeWord(inst.value, modulus) : 0n;
    const valid = value >= 0n && value <= 0x10ffffn && !(value >= 0xd800n && value <= 0xdfffn);
    // Literal tags are loader data. Future arithmetic handlers must update the
    // same scalar-value tag when they produce a stack value at runtime.
    installFrame(records[pc], [handlers.get(inst.op)!, fixedWord(value, program.width), records[pc + 1].pointer,
      handlers.get(valid ? "putc-write" : "invalidOutput")!, handlers.get("stackOverflow")!, fromNumber(OPCODE_IDS[inst.op])]);
  }
  installFrame(records[program.instructions.length], [handlers.get("fellOffProgram")!]);
  installFrame(empty, ["0", "0", "0", handlers.get("stackUnderflow")!, handlers.get("push-write")!]);
  for (let depth = 0; depth < stack.length; depth++) {
    installFrame(stack[depth], [empty.pointer, stack[Math.max(0, depth - 1)].pointer, stack[Math.min(stack.length - 1, depth + 1)].pointer,
      handlers.get(depth > capacity ? "stackOverflow" : "push-write")!, "0", fromNumber(depth)]);
  }
  values.set("pc", records[0].pointer); values.set("sp", capacity === 1 ? empty.pointer : stack[0].pointer);
  if (capacity === 1) values.set("$empty", empty.pointer);
  for (const [name, value] of values) layout.patch(layout.reg(name), value);
  return {
    kind: "literal" as const,
    patches: [...layout.patches.values()], entry, next: NEXT, handlers, faults, records, stack, empty,
    symbols: layout.symbols, bytecode, program, stackCapacity: capacity,
    codeCells: [...layout.patches.values()].filter((p) => p.at.bank === CODE_BANK).length,
  };
}

export function assembleHeLLVM(input: BytecodeProgram | Uint8Array, options: HeLLVMOptions = {}) {
  const plan = planHeLLVM(input, options);
  const linked = installBootstrap(bootstrapCycleImage(59, true), 30, options.maxSourceCells ?? 500_000_000, 3, plan);
  return { ...linked, codeCells: plan.codeCells, vm: plan };
}

export type HeLLVMPlan = ReturnType<typeof planHeLLVM>;
export type HeLLVMImage = ReturnType<typeof assembleHeLLVM>;
