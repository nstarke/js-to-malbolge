/** Restorable accumulator loops installed by the register initializer. */
import { permanentNopValues, restorableValue, valueForOp, fillerValue } from "./cycles.js";
import { fixedWord, type InitialValue, type RegisterProgram } from "./init.js";

const NOPS = Array.from({ length: 94 }, (_, residue) => permanentNopValues(residue));

export interface AccumulatorInstruction {
  /** Native operations: crazy/rotate write the register and A; input writes A. */
  op: "p" | "*" | "/" | "<";
  register: string;
}
export interface AccumulatorLoop {
  width: number;
  registers: Record<string, InitialValue>;
  /** Leaves a finite boolean (0 or 1) in A. Executes at least once. */
  body: AccumulatorInstruction[];
  /** Selector mode: A is ...111, with trit 1 zero to continue or one to halt. */
  condition?: "boolean" | "selector";
}
export interface LoopImage {
  runtime: NonNullable<RegisterProgram["runtime"]>;
  symbols: Map<string, number>;
  entry: number;
  end: number;
  activeCells: number[];
}

/**
 * Compile an actual loop: each active traversal is followed by a traversal
 * of nops that restores its instruction cells. The boolean in A chooses
 * another iteration or halt. Installation still requires a known width.
 */
export function planAccumulatorLoop(program: AccumulatorLoop): LoopImage {
  fixedWord(0, program.width);
  if (program.condition !== undefined && !["boolean", "selector"].includes(program.condition)) throw new RangeError("unknown loop condition mode");
  const internal = ["one", "scratch", "flag", "zero", "next", "tail"];
  const names = Object.keys(program.registers);
  for (const name of names) {
    if (name.startsWith("$loop.")) throw new RangeError("reserved loop register name");
    fixedWord(program.registers[name], program.width);
  }
  for (const inst of program.body) {
    if (!names.includes(inst.register)) throw new RangeError(`unknown loop register ${inst.register}`);
    if (!["p", "*", "/", "<"].includes(inst.op)) throw new RangeError("unsupported accumulator instruction");
  }
  const privateName = (name: string) => `$loop.${name}`;
  const code: AccumulatorInstruction[] = [];
  const emit = (op: AccumulatorInstruction["op"], name: string, count = 1) => {
    for (let i = 0; i < count; i++) code.push({ op, register: privateName(name) });
  };
  if ((program.condition ?? "boolean") === "boolean") {
    emit("*", "one");
    emit("p", "scratch", 2); emit("p", "flag", 2); emit("p", "zero", 3);
  }
  code.push(...program.body);
  if ((program.condition ?? "boolean") === "boolean") {
    emit("p", "scratch"); emit("p", "flag"); emit("*", "flag", program.width - 1);
    emit("p", "zero");
  }
  emit("p", "next"); emit("*", "tail");

  // 2124 has only 0/2 trits and trit 1 is zero. Changing that trit to
  // one selects entry=2127; leaving it zero selects the halt at 2125.
  const base = 2124, entry = base + 3;
  const image = new Map<number, InitialValue>();
  const activeCells: number[] = [];
  type Steering = { register: string; offset: number; target: string; adjustment: number };
  const steering: Steering[] = [];
  const offsets = new Map<string, Map<number, string>>();
  let c = entry + 1, previous: { c: number; register: string } | undefined;
  let first = { register: "", adjustment: 0 };
  for (const inst of code) {
    let j = c;
    while (restorableValue("j", j) === null) j++;
    let op = j + 1;
    while (restorableValue(inst.op, op) === null) op++;
    if (previous) {
      const used = offsets.get(previous.register) ?? new Map<number, string>();
      offsets.set(previous.register, used);
      const target = `${inst.register}:${op - j}`;
      while (used.has(j - previous.c) && used.get(j - previous.c) !== target) { j += 94; op += 94; }
      const offset = j - previous.c;
      if (!used.has(offset)) steering.push({ register: previous.register, offset, target: inst.register, adjustment: op - j });
      used.set(offset, target);
    } else first = { register: inst.register, adjustment: op - j };
    for (; c < op; c++) {
      const choices = NOPS[c % 94];
      if (!choices.length) throw new Error(`no permanent nop at ${c}`);
      image.set(c, choices.includes(74) ? 74 : choices[0]);
    }
    image.set(j, restorableValue("j", j)!); image.set(op, restorableValue(inst.op, op)!);
    activeCells.push(j, op); previous = { c: op, register: inst.register }; c = op + 1;
  }
  const end = c, length = end - entry - 1;
  image.set(entry, fillerValue(entry)); image.set(base, fillerValue(base));
  image.set(base + 1, valueForOp("v", base + 1)); image.set(end, valueForOp("i", end));
  const symbols = new Map<string, number>();
  let address = end + 128;
  for (const name of [...names, ...internal.filter((n) => n !== "next").map(privateName)]) {
    symbols.set(name, address);
    const used = offsets.get(name);
    address += (used ? Math.max(...used.keys()) : 0) + 128;
  }
  const tail = symbols.get(privateName("tail"))!;
  const next = tail + 2 + length;
  symbols.set(privateName("next"), next);
  const values = { ...program.registers, ...Object.fromEntries(internal.map((n) => [privateName(n), n === "one" ? "1" : n === "next" ? entry : 0])) };
  const patch = (cell: number, value: InitialValue) => {
    if (image.has(cell) && image.get(cell) !== value) throw new RangeError(`loop data overlaps at ${cell}`);
    image.set(cell, value);
  };
  for (const [name, cell] of symbols) patch(cell, values[name]);
  for (const s of steering) patch(symbols.get(s.register)! + s.offset, symbols.get(s.target)! - s.adjustment);
  patch(tail + 1, entry); patch(next + 1, symbols.get(first.register)! - first.adjustment);
  for (const [cell, value] of image) {
    if (cell >= 3 ** program.width - 32) throw new RangeError("loop exceeds the fixed address width");
    fixedWord(value, program.width);
  }
  return { runtime: { patches: [...image].map(([cell, value]) => ({ cell, value })), entryPointer: next }, symbols, entry, end, activeCells };
}
