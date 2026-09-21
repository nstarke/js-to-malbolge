/** Fixed-width, straight-line register backend. All initialization runs on the target. */
import { base, canon, fromBigInt, toBigInt, tritAt, type Trits } from "../malbolge/trits.js";
import { encryptValue, fillerValue, isValidAt, valueForOp, type Op } from "./cycles.js";

export type InitialValue = number | bigint | Trits;
export type RegisterInstruction =
  | { op: "require-width"; width: number }
  | { op: "set"; dest: string; value: InitialValue }
  | { op: "copy"; dest: string; source: string }
  | { op: "crazy"; dest: string; a: string; b: string }
  | { op: "rotate"; dest: string; count?: number }
  | { op: "putc"; source: string }
  | { op: "getc"; dest: string }
  | { op: "array-base"; dest: string; array: string }
  | { op: "load"; dest: string; pointer: string }
  | { op: "store"; pointer: string; source: string };

export interface RegisterProgram {
  width: number;
  registers: Record<string, InitialValue>;
  instructions: RegisterInstruction[];
  /** Indexed memory frames, allocated in initialization code after it has executed. */
  arrays?: Record<string, InitialValue[]>;
  /** Internal runtime image: patch consumed code, then jump via a pointer cell. */
  runtime?: {
    patches: { cell: number; value: InitialValue }[];
    entryPointer: number;
    /** Transfer live register values after the straight-line instructions finish. */
    bindings?: { cell: number; source: string }[];
  };
  /** Additional data words, after the executable code; useful for future wide tapes. */
  initialize?: { cell: number; value: InitialValue }[];
}
export interface InitializedProgram {
  source: string;
  image: Uint8Array;
  symbols: Map<string, number>;
  width: number;
  codeEnd: number;
  initializationEnd: number;
  arrays: Map<string, { base: number; length: number; stride: number }>;
}
export interface RegisterAssembleOptions {
  /** Bound both emitted code and sparse data padding. Defaults to two million cells. */
  maxSourceCells?: number;
}

// Registers with source-legal self pointers at R+1. Low cells are data, not code.
const ONE = 67, TWO = 81, ADDRESS = 96;
const WORK = [34, 49, 114];
const RETURNS = [43, 60, 79, 95, 118, 124];
const SLOTS = [44, 46, 54, 56, 58, 63, 65, 69, 71, 73, 75, 77, 83, 85, 87, 89, 91, 93, 111, 116, 119, 121];
const DISPATCH = new Map([[34, 48], [67, 51], [81, 53], [96, 39], [114, 62]]);

export function fixedWord(value: InitialValue, width: number): Trits {
  if (!Number.isInteger(width) || width < 10 || width > 20) throw new RangeError("fixed width must be an integer from 10 through 20");
  if (typeof value === "string") {
    if (!/^[012]+$/.test(value)) throw new RangeError("invalid trit value");
    const v = canon(value);
    if (base(v) === 2 || v.length - 1 > width) throw new RangeError("initializer supports base 0 or 1 values within the fixed width");
    return v;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("initial value must be a safe integer");
  const modulus = 3n ** BigInt(width);
  return fromBigInt((BigInt(value) % modulus + modulus) % modulus);
}

/**
 * Emit legal source, using no host memory injection and no input during initialization.
 * Register instructions may be repeated with new operands; code is unrolled, not a loop.
 */
export function assembleRegisters(program: RegisterProgram, options: RegisterAssembleOptions = {}): InitializedProgram {
  fixedWord(0, program.width);
  for (const inst of program.instructions) {
    if (inst.op === "require-width" && inst.width !== program.width) {
      throw new RangeError(`arithmetic width ${inst.width} does not match program width ${program.width}`);
    }
  }
  const maxSourceCells = options.maxSourceCells ?? 2_000_000;
  if (!Number.isSafeInteger(maxSourceCells) || maxSourceCells < 128) throw new RangeError("maxSourceCells must be a safe integer of at least 128");
  const names = Object.keys(program.registers);
  if (names.length > SLOTS.length) throw new RangeError(`register backend supports at most ${SLOTS.length} registers`);
  const symbols = new Map(names.map((name, i) => [name, SLOTS[i]]));
  const cells = new Map<number, number>();
  const selfLinked = new Set([ONE, TWO, ADDRESS, ...WORK]);
  const highReturns = new Map<number, number>();
  const arrays = new Map<string, { base: number; values: InitialValue[] }>();
  let arrayEnd = 128;
  for (const [name, values] of Object.entries(program.arrays ?? {})) {
    if (!values.length) throw new RangeError(`array ${name} must not be empty`);
    arrays.set(name, { base: arrayEnd, values });
    arrayEnd += 3 * values.length;
  }
  const runtime = program.runtime;
  if (runtime) {
    const seen = new Set<number>();
    for (const patch of runtime.patches) {
      if (!Number.isSafeInteger(patch.cell) || patch.cell < arrayEnd || patch.cell >= 3 ** program.width - 32 || patch.cell >= maxSourceCells - 32) {
        throw new RangeError("runtime patch must follow the arrays and fit the address/source bounds");
      }
      fixedWord(patch.value, program.width);
      if (seen.has(patch.cell)) throw new RangeError(`duplicate runtime patch ${patch.cell}`);
      seen.add(patch.cell);
    }
    if (!runtime.patches.some((p) => p.cell === runtime.entryPointer)) throw new RangeError("runtime entry pointer must be initialized");
    for (const binding of runtime.bindings ?? []) {
      if (!seen.has(binding.cell)) throw new RangeError("runtime binding must target an initialized cell");
      if (!symbols.has(binding.source)) throw new RangeError(`unknown register ${binding.source}`);
    }
  }
  if (arrayEnd >= 3 ** program.width) throw new RangeError("array frames exceed the fixed address width");
  const written = new Map<number, Trits>();
  const unknownWritten = new Set<number>();
  const reclaimed = new Set<number>();
  const directives = program.initialize ?? [];
  const reservedHigh = new Set<number>();
  for (const { cell, value } of directives) {
    if (!Number.isSafeInteger(cell) || cell < 127 || cell >= 3 ** program.width - 24) throw new RangeError("data cell must be above the low bank and within the fixed address width");
    if (cell >= maxSourceCells - 24) throw new RangeError("data cell exceeds the source cell budget");
    if (reservedHigh.has(cell)) throw new RangeError(`duplicate initialization cell ${cell}`);
    reservedHigh.add(cell);
    fixedWord(value, program.width);
  }
  for (const { cell } of directives) {
    let ret = cell + 1;
    while (reservedHigh.has(ret) || !isValidAt(38, ret)) ret++;
    highReturns.set(cell, ret);
    cells.set(ret, 38);
    cells.set(cell, fillerValue(cell));
  }
  const set = (addr: number, value: number) => {
    if (!isValidAt(value, addr)) throw new Error(`invalid generated source ${value} at ${addr}`);
    cells.set(addr, value);
  };
  set(0, 98); // i: jump to 98, resume at 99; D=1.
  set(1, 38);
  set(98, fillerValue(98));
  set(99, valueForOp("j", 99)); // D=39
  for (let addr = 100; addr < 110; addr++) set(addr, valueForOp("o", addr));
  set(110, valueForOp("i", 110)); // D=49 holds 126; resume at C=127, D=50.
  set(126, fillerValue(126));
  for (const addr of RETURNS) set(addr, 38);
  for (const [reg, slot] of DISPATCH) set(slot, reg - 1);
  for (const [reg, value] of [[34, 83], [49, 126], [67, 108], [81, 36], [96, 37], [114, 42]]) {
    set(reg, value);
    set(reg + 1, reg - 1);
  }
  for (const addr of symbols.values()) {
    set(addr, fillerValue(addr));
    set(addr + 1, fillerValue(addr + 1));
  }
  let c = 127;
  const emit = (op: Op) => {
    if (c >= maxSourceCells) throw new RangeError("generated code exceeds the source cell budget");
    set(c, valueForOp(op, c)); c++;
  };
  const nops = (count: number) => { for (let i = 0; i < count; i++) emit("o"); };
  nops(10); emit("j"); // D=60 then bank start 39.
  const select = (addr: number) => {
    if (addr > 126) {
      emit("j"); // bank[39] -> ADDRESS
      emit("j"); // [ADDRESS] -> target-1
    } else {
      const slot = DISPATCH.get(addr);
      if (slot !== undefined && (addr < 39 || slot < addr)) {
        nops(slot - 39); emit("j");
      } else {
        if (addr < 39) throw new Error(`unaddressable low cell ${addr}`);
        nops(addr - 39);
      }
    }
  };
  const back = (d: number, target?: number) => {
    if (target !== undefined && reclaimed.has(target)) {
      // A consumed instruction is a printable encrypted character, so its value
      // can steer D back into the low bank before it becomes a permanent return.
      let ret = d, value = 0;
      for (; ret < c; ret++) {
        if (unknownWritten.has(ret)) continue;
        const word = written.get(ret);
        if (word === undefined && cells.get(ret) === undefined) continue;
        if (word !== undefined && (base(word) !== 0 || word.length > 6)) continue;
        const v = word === undefined ? encryptValue(cells.get(ret)!) : Number(toBigInt(word));
        if (v >= 33 && v <= 123) { value = v; break; }
      }
      if (!value) throw new Error("no consumed instruction available for return steering");
      nops(ret - d); emit("j");
      const lowRet = RETURNS.find((r) => r >= value + 1)!;
      nops(lowRet - value - 1); emit("j");
      return;
    }
    const ret = target !== undefined && target > 126 ? highReturns.get(target)! : RETURNS.find((r) => r >= d);
    if (ret === undefined) throw new Error(`no return steering cell after ${d}`);
    nops(ret - d); emit("j");
  };
  const operate = (addr: number, op: "*" | "p", count = 1) => {
    if (!count) return;
    select(addr);
    for (let i = 0; i < count; i++) {
      emit(op);
      if (i + 1 < count) {
        if (selfLinked.has(addr)) emit("j");
        else { back(addr + 1, addr); select(addr); }
      }
    }
    back(addr + 1, addr);
  };
  const read = (addr: number) => operate(addr, "*", addr === ONE ? 1 : program.width);
  const reset = (addr: number, zero = false) => { read(ONE); operate(addr, "p", zero ? 3 : 2); };
  const copy = (dest: number, src: number) => {
    if (dest === src) return;
    const scratch = WORK.find((r) => r !== dest && r !== src)!;
    reset(dest); reset(scratch);
    read(src); operate(scratch, "p"); operate(dest, "p");
  };
  // Seed ...111 from 108 (no 2-trits), and finite 2 from source value 83.
  operate(ONE, "p");
  operate(34, "p");
  copy(TWO, 34);

  const build = (value: Trits): number => {
    if (value === "1") return ONE;
    if (value === "20") return TWO;
    const b = base(value);
    const digits = Array.from({ length: program.width }, (_, i) => {
      const t = tritAt(value, i);
      return b === 1 ? (t === 2 ? 2 : 1 - t) : t;
    });
    while (digits.length && digits[digits.length - 1] === 0) digits.pop();
    let current = WORK[0];
    reset(current, true);
    for (const digit of digits) {
      if (digit !== 0) {
        const [first, second] = WORK.filter((r) => r !== current);
        reset(first); reset(second);
        if (digit === 1) { read(TWO); operate(first, "p"); }
        read(TWO); operate(second, "p");
        read(current); operate(first, "p"); operate(second, "p");
        current = second;
      }
      operate(current, "*");
    }
    if (digits.length) operate(current, "*", program.width - digits.length);
    if (b === 1) {
      const dest = WORK.find((r) => r !== current)!;
      reset(dest); read(current); operate(dest, "p"); current = dest;
    }
    return current;
  };
  const initialize = (addr: number, value: InitialValue) => {
    if (addr > 126) copy(ADDRESS, build(fromBigInt(BigInt(addr - 1))));
    const word = fixedWord(value, program.width);
    copy(addr, build(word));
    if (reclaimed.has(addr)) written.set(addr, word);
  };
  for (const [name, addr] of symbols) {
    initialize(addr + 1, addr - 1);
    selfLinked.add(addr);
    initialize(addr, program.registers[name]);
  }
  for (const { cell, value } of directives) initialize(cell, value);
  // Reclaim only code that has already executed, leaving future code untouched.
  while (c < arrayEnd + 32) read(ONE);
  for (const [name, { base: first, values }] of arrays) {
    for (let i = 0; i < values.length; i++) {
      const cell = first + 3 * i;
      reclaimed.add(cell); reclaimed.add(cell + 1); reclaimed.add(cell + 2);
      initialize(cell + 2, 38);
      highReturns.set(cell, cell + 2); highReturns.set(cell + 1, cell + 2);
      reclaimed.delete(cell); reclaimed.delete(cell + 1);
      initialize(cell + 1, cell - 1);
      selfLinked.add(cell);
      initialize(cell, values[i]);
      written.set(cell, fixedWord(values[i], program.width));
      written.set(cell + 1, fromBigInt(BigInt(cell - 1)));
    }
  }
  if (runtime) {
    const end = runtime.patches.reduce((end, p) => Math.max(end, p.cell + 32), 0);
    while (c < end) read(ONE);
    // Cache common image characters in unused low registers. Code padding and
    // opcodes recur thousands of times; rebuilding each would dominate startup.
    const counts = new Map<Trits, number>();
    for (const p of runtime.patches) {
      const word = fixedWord(p.value, program.width);
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const cache = new Map<Trits, number>();
    const spare = SLOTS.slice(names.length);
    for (const [word, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      if (!spare.length || count < 3) break;
      const slot = spare.shift()!;
      initialize(slot + 1, slot - 1); selfLinked.add(slot);
      initialize(slot, word); cache.set(word, slot);
    }
    let previous = -2;
    for (const patch of [...runtime.patches].sort((a, b) => a.cell - b.cell)) {
      reclaimed.add(patch.cell);
      if (patch.cell === previous + 1) {
        // Increment the known previous address with a ternary ripple. Only the
        // trailing 2-trits and the following trit change; higher trits survive.
        let n = previous - 1, turns = 0, current = ADDRESS;
        for (;;) {
          const digit = n % 3;
          const [first, second] = WORK.filter((r) => r !== current);
          reset(first); reset(second);
          if (digit !== 1) { read(TWO); operate(first, "p"); }
          if (digit !== 2) { read(TWO); operate(second, "p"); }
          read(current); operate(first, "p"); operate(second, "p"); current = second;
          if (digit !== 2) break;
          operate(current, "*"); turns++; n = Math.floor(n / 3);
        }
        if (turns) operate(current, "*", program.width - turns);
        copy(ADDRESS, current);
      } else copy(ADDRESS, build(fromBigInt(BigInt(patch.cell - 1))));
      const word = fixedWord(patch.value, program.width);
      copy(patch.cell, cache.get(word) ?? build(word));
      written.set(patch.cell, word); previous = patch.cell;
    }
  }
  const indirect = (op: "*" | "p", count = 1) => {
    select(ADDRESS); emit("j");
    for (let i = 0; i < count; i++) { emit(op); if (i + 1 < count) emit("j"); }
    emit("o"); emit("j"); // frame self pointer, then frame return (38).
  };
  const initializationEnd = c;
  const reg = (name: string) => {
    const addr = symbols.get(name);
    if (addr === undefined) throw new RangeError(`unknown register ${name}`);
    return addr;
  };
  for (const inst of program.instructions) {
    switch (inst.op) {
      case "require-width": break; // Compile-time contract, emits no machine instruction.
      case "array-base": {
        const array = arrays.get(inst.array);
        if (!array) throw new RangeError(`unknown array ${inst.array}`);
        initialize(reg(inst.dest), array.base - 1); break;
      }
      case "load": {
        const dest = reg(inst.dest);
        copy(ADDRESS, reg(inst.pointer));
        reset(dest); reset(WORK[0]); indirect("*", program.width);
        operate(WORK[0], "p"); operate(dest, "p"); break;
      }
      case "store": {
        copy(ADDRESS, reg(inst.pointer));
        read(ONE); indirect("p", 2);
        reset(WORK[0]); read(reg(inst.source)); operate(WORK[0], "p"); indirect("p"); break;
      }
      case "set": initialize(reg(inst.dest), inst.value); break;
      case "copy": copy(reg(inst.dest), reg(inst.source)); break;
      case "crazy": {
        const dest = reg(inst.dest), a = reg(inst.a), b = reg(inst.b);
        if (dest === a && dest !== b) {
          copy(ADDRESS, a); copy(dest, b); read(ADDRESS);
        } else { copy(dest, b); read(a); }
        operate(dest, "p"); break;
      }
      case "rotate": {
        const count = inst.count ?? 1;
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("rotation count must be a nonnegative safe integer");
        operate(reg(inst.dest), "*", count % program.width); break;
      }
      case "putc": read(reg(inst.source)); emit("<"); back(40); break;
      case "getc": {
        const dest = reg(inst.dest), scratch = WORK[0];
        reset(dest); reset(scratch); emit("/"); back(40);
        operate(scratch, "p"); operate(dest, "p"); break;
      }
      default: throw new RangeError("unknown register instruction");
    }
  }
  if (runtime) {
    for (const binding of runtime.bindings ?? []) {
      copy(ADDRESS, build(fromBigInt(BigInt(binding.cell - 1))));
      copy(binding.cell, reg(binding.source));
      unknownWritten.add(binding.cell);
    }
    copy(ADDRESS, build(fromBigInt(BigInt(runtime.entryPointer - 1))));
    select(ADDRESS); emit("j"); emit("i");
  } else emit("v");
  const codeEnd = c - 1;
  for (const { cell } of directives) if (cell <= codeEnd) throw new RangeError(`initialization cell ${cell} overlaps code ending at ${codeEnd}`);
  let last = codeEnd;
  for (const addr of cells.keys()) last = Math.max(last, addr);
  const image = new Uint8Array(last + 1);
  for (let addr = 0; addr <= last; addr++) image[addr] = cells.get(addr) ?? fillerValue(addr);
  return { source: Array.from(image, (v) => String.fromCharCode(v)).join(""), image, symbols, width: program.width, codeEnd, initializationEnd,
    arrays: new Map([...arrays].map(([name, array]) => [name, { base: array.base, length: array.values.length, stride: 3 }])) };
}
