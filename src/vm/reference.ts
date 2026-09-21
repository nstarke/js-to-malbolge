import { validateBytecodeProgram, normalizeWord, wordModulus, type BytecodeProgram } from "./isa.js";

export interface VMResult {
  status: "halted" | "step-limit";
  output: string;
  steps: number;
  pc: number;
  stack: bigint[];
  locals: bigint[];
  returnStack: number[];
}

/** Deterministic oracle for the future HeLL VM. Locals are shared across calls. */
export function runVM(program: BytecodeProgram, options: { input?: string; maxSteps?: number } = {}): VMResult {
  const modulus = wordModulus(program.width);
  const maxSteps = options.maxSteps ?? 1_000_000;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new RangeError("maxSteps must be a nonnegative safe integer");
  validateBytecodeProgram(program);
  const code = program.instructions;
  const stack: bigint[] = [];
  const locals = Array<bigint>(program.localCount).fill(0n);
  const returnStack: number[] = [];
  const input = Array.from(options.input ?? "", (ch) => ch.codePointAt(0)!);
  const output: string[] = [];
  let inputPosition = 0;
  let pc = 0;
  let steps = 0;
  const fail = (message: string): never => { throw new Error(`pc ${pc}: ${message}`); };
  const need = (count: number) => { if (stack.length < count) fail("stack underflow"); };
  const push = (value: bigint) => stack.push(normalizeWord(value, modulus));
  const result = (status: VMResult["status"]): VMResult => ({ status, output: output.join(""), steps, pc, stack, locals, returnStack });
  while (steps < maxSteps) {
    const inst = code[pc];
    if (!inst) fail("execution fell off the program");
    steps++;
    switch (inst.op) {
      case "halt": return result("halted");
      case "push": push(inst.value); break;
      case "load": stack.push(locals[inst.index]); break;
      case "store": need(1); locals[inst.index] = stack.pop()!; break;
      case "dup": need(1); stack.push(stack[stack.length - 1]); break;
      case "drop": need(1); stack.pop(); break;
      case "swap": {
        need(2);
        const b = stack.pop()!, a = stack.pop()!;
        stack.push(b, a);
        break;
      }
      case "add": case "sub": case "mul": case "div": case "mod": case "eq": case "lt": case "le": {
        need(2);
        const b = stack.pop()!, a = stack.pop()!;
        if ((inst.op === "div" || inst.op === "mod") && b === 0n) fail("division by zero");
        const value = inst.op === "add" ? a + b : inst.op === "sub" ? a - b : inst.op === "mul" ? a * b :
          inst.op === "div" ? a / b : inst.op === "mod" ? a % b :
          BigInt(inst.op === "eq" ? a === b : inst.op === "lt" ? a < b : a <= b);
        push(value);
        break;
      }
      case "jump": pc = inst.target; continue;
      case "jz": need(1); if (stack.pop() === 0n) { pc = inst.target; continue; } break;
      case "call": returnStack.push(pc + 1); pc = inst.target; continue;
      case "ret":
        if (!returnStack.length) fail("return stack underflow");
        pc = returnStack.pop()!;
        continue;
      case "getc": {
        const value = input[inputPosition++];
        if (value !== undefined && BigInt(value) > (modulus - 1n) / 2n) fail("input code point does not fit the word width");
        push(value === undefined ? -1n : BigInt(value));
        break;
      }
      case "putc": {
        need(1);
        const cp = Number(stack.pop()!);
        if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail("invalid Unicode code point");
        output.push(String.fromCodePoint(cp));
        break;
      }
    }
    pc++;
  }
  return result("step-limit");
}
