/** Register instructions lowered into a single restorable accumulator loop. */
import { fixedWord, assembleRegisters, type InitialValue, type RegisterInstruction, type RegisterAssembleOptions } from "./init.js";
import { planAccumulatorLoop, type AccumulatorInstruction, type LoopImage } from "./control.js";

export interface RegisterLoopProgram {
  width: number;
  registers: Record<string, InitialValue>;
  arrays?: Record<string, InitialValue[]>;
  body: RegisterInstruction[];
  /** Finite boolean register tested after each body execution. */
  while: string;
}

export function planRegisterLoop(program: RegisterLoopProgram): LoopImage {
  fixedWord(0, program.width);
  const registers = { ...program.registers };
  for (const name of Object.keys(registers)) if (name.startsWith("$register.")) throw new RangeError("reserved register-loop name");
  const requireRegister = (name: string) => {
    if (!Object.hasOwn(registers, name)) throw new RangeError(`unknown register ${name}`);
    return name;
  };
  requireRegister(program.while);
  const mutated = new Set(program.body.flatMap((i) => "dest" in i ? [i.dest] : []));
  const immutable = new Map<string, string>();
  const known = new Map<string, string>();
  const bases = new Map<string, number | undefined>();
  for (const [name, value] of Object.entries(registers)) {
    const word = fixedWord(value, program.width);
    bases.set(name, mutated.has(name) ? undefined : Number(word.at(-1)));
    if (!mutated.has(name)) { immutable.set(word, name); known.set(name, word); }
  }
  let serial = 0;
  const scratch = (label: string) => { const name = `$register.${label}.${serial++}`; registers[name] = 0; bases.set(name, 0); return name; };
  const constant = (value: InitialValue) => {
    const word = fixedWord(value, program.width);
    const existing = immutable.get(word);
    if (existing) return existing;
    const name = scratch("constant"); registers[name] = value; bases.set(name, Number(word.at(-1)));
    immutable.set(word, name); known.set(name, word); return name;
  };
  const one = constant("1"), max = constant(3n ** BigInt(program.width) - 1n);
  const swap = scratch("copy"), save = scratch("save"), mask = scratch("mask"), pointer = scratch("pointer"), capture = scratch("capture");
  let free = scratch("free");
  const locations = new Map(Object.keys(program.registers).map((name) => [name, name]));
  const body: AccumulatorInstruction[] = [];
  let aliases = new Set<string>(), aBase: number | undefined;
  const native = (op: AccumulatorInstruction["op"], register: string) => {
    body.push({ op, register });
    if (op === "p") {
      aBase = aBase === undefined ? undefined : 1 - aBase;
      bases.set(register, aBase); aliases = new Set([register]);
    } else if (op === "*") { aBase = bases.get(register); aliases = new Set([register]); }
    else if (op === "/") { aliases.clear(); aBase = 0; } // finite-input ABI
  };
  const ones = () => { if (!aliases.has(one)) native("*", one); aBase = 1; aliases.add(one); };
  const reset = (dest: string, zero = false) => {
    ones(); native("p", dest); native("p", dest);
    aBase = 1; bases.set(dest, 1); aliases.add(one);
    if (zero) { native("p", dest); aBase = 0; bases.set(dest, 0); }
  };
  const read02 = (name: string) => { ones(); native("p", name); };
  const loadMask = () => { reset(mask); native("p", max); native("p", mask); };
  const read = (name: string) => {
    if (aliases.has(name)) return;
    const value = known.get(name);
    if (value === "1") { ones(); return; }
    if (value?.at(-1) === "0" && !value.includes("1")) { read02(name); return; }
    const base = bases.get(name);
    if (base !== undefined && program.width > (base === 1 ? 6 : 12)) {
      for (let i = 0; i < 2; i++) {
        if (base === 1) read02(max); else loadMask();
        native("p", name);
      }
      bases.set(name, base); aBase = base;
    } else for (let i = 0; i < program.width; i++) native("*", name);
  };
  const copy = (dest: string, source: string) => {
    if (dest === source) return;
    const value = known.get(source);
    if (value === "1" || value === "0") { reset(dest, value === "0"); return; }
    const sourceBase = bases.get(source);
    reset(dest); reset(swap); read(source); native("p", swap); native("p", dest);
    bases.set(dest, sourceBase); aBase = sourceBase; aliases.add(source);
  };
  const indirect = () => {
    body.push({ op: "p", register: pointer, indirect: { capture } });
    // Two crazies: value, then capture. Their repeating bases cancel.
    bases.set(capture, aBase); aliases = new Set([capture]);
  };
  const arrayPointers: Record<string, string> = {};
  const arrayBases = new Map<string, string>();
  for (const original of program.body) {
    const inst = { ...original };
    for (const field of ["dest", "source", "pointer", "a", "b"] as const) {
      if (field in inst) {
        const object = inst as unknown as Record<string, string>;
        requireRegister(object[field]); object[field] = locations.get(object[field])!;
      }
    }
    switch (inst.op) {
      case "require-width": if (inst.width !== program.width) throw new RangeError("arithmetic width does not match loop width"); break;
      case "set": copy(inst.dest, constant(inst.value)); break;
      case "copy": copy(inst.dest, inst.source); break;
      case "crazy": {
        let dest = inst.dest;
        if (dest === inst.a && dest !== inst.b) {
          dest = free; free = inst.dest;
          locations.set((original as Extract<RegisterInstruction, { op: "crazy" }>).dest, dest);
        }
        copy(dest, inst.b); read(inst.a); native("p", dest); break;
      }
      case "rotate": {
        const count = inst.count ?? 1;
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("invalid rotation count");
        for (let i = 0; i < count % program.width; i++) native("*", inst.dest);
        break;
      }
      case "getc": reset(inst.dest); reset(swap); native("/", swap); native("p", swap); native("p", inst.dest); break;
      case "putc": read(inst.source); native("<", inst.source); break;
      case "array-base": {
        if (!Object.hasOwn(program.arrays ?? {}, inst.array)) throw new RangeError(`unknown array ${inst.array}`);
        let source = arrayBases.get(inst.array);
        if (!source) { source = scratch("array"); arrayBases.set(inst.array, source); arrayPointers[source] = inst.array; }
        copy(inst.dest, source); break;
      }
      case "load": {
        copy(pointer, inst.pointer); reset(inst.dest);
        reset(capture); loadMask(); indirect();
        reset(capture); loadMask(); indirect(); native("p", inst.dest); bases.set(inst.dest, 0); aBase = 0; break;
      }
      case "store": {
        if (bases.get(inst.source) === 1) throw new RangeError("loop stores require finite words");
        copy(pointer, inst.pointer); reset(save); reset(capture); ones(); indirect(); native("p", save); indirect();
        reset(swap); read(inst.source); native("p", swap); indirect(); break;
      }
      default: throw new RangeError("unknown register-loop instruction");
    }
  }
  // Restore the logical register locations before the next iteration. A spare
  // register breaks cycles in this parallel assignment without losing values.
  const moves = new Map([...locations].filter(([dest, source]) => dest !== source));
  while (moves.size) {
    const sources = new Set(moves.values());
    const move = [...moves].find(([dest]) => !sources.has(dest));
    if (move) { copy(move[0], move[1]); moves.delete(move[0]); }
    else {
      const dest = moves.keys().next().value!;
      copy(save, dest);
      for (const [target, source] of moves) if (source === dest) moves.set(target, save);
    }
  }
  read(program.while);
  return planAccumulatorLoop({ width: program.width, registers, body, arrays: program.arrays, arrayPointers });
}

export function assembleRegisterLoop(program: RegisterLoopProgram, options: RegisterAssembleOptions = {}) {
  const loop = planRegisterLoop(program);
  const installed = assembleRegisters({ width: program.width, registers: {}, instructions: [], runtime: loop.runtime }, options);
  return { ...installed, symbols: loop.symbols, arrays: loop.arrays, loop };
}
