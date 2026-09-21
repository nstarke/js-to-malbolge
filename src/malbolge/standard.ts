/**
 * Interpreter for standard Malbolge (Olmstead 1998 semantics).
 */
import { MEM_SIZE, crazy10, decodeOp, encrypt, isValidSourceInstruction, rotr10 } from "./tables.js";

export class MalbolgeLoadError extends Error {
  constructor(message: string, public readonly index: number) {
    super(message);
    this.name = "MalbolgeLoadError";
  }
}

export type StepStatus = "ok" | "halted" | "hang";

export interface RunOptions {
  input?: string | Uint8Array;
  maxSteps?: number;
}

export interface RunResult {
  status: "halted" | "hang" | "step-limit";
  /** Output bytes decoded as Latin-1. */
  output: string;
  outputBytes: Uint8Array;
  steps: number;
}

/** Parse and validate source, returning the initial 59,049-word memory. */
export function loadStandard(source: string): Uint16Array {
  const mem = new Uint16Array(MEM_SIZE);
  let i = 0;
  for (let k = 0; k < source.length; k++) {
    const ch = source[k];
    if (/\s/.test(ch)) continue;
    const code = source.charCodeAt(k);
    if (code < 33 || code > 126) {
      throw new MalbolgeLoadError(`non-printable character U+${code.toString(16)} at source offset ${k}`, i);
    }
    if (!isValidSourceInstruction(code, i)) {
      throw new MalbolgeLoadError(`invalid instruction '${ch}' at address ${i}`, i);
    }
    if (i === MEM_SIZE) throw new MalbolgeLoadError("program too long", i);
    mem[i++] = code;
  }
  if (i < 2) throw new MalbolgeLoadError("program too short", i);
  for (; i < MEM_SIZE; i++) mem[i] = crazy10(mem[i - 1], mem[i - 2]);
  return mem;
}

export class StandardMachine {
  a = 0;
  c = 0;
  d = 0;
  steps = 0;
  readonly output: number[] = [];
  private inputPos = 0;
  private readonly input: Uint8Array;

  constructor(public readonly mem: Uint16Array, input: string | Uint8Array = "") {
    this.input = typeof input === "string" ? new TextEncoder().encode(input) : input;
  }

  static fromSource(source: string, input?: string | Uint8Array): StandardMachine {
    return new StandardMachine(loadStandard(source), input);
  }

  step(): StepStatus {
    const mem = this.mem;
    const cell = mem[this.c];
    if (cell < 33 || cell > 126) return "hang";
    switch (decodeOp(cell, this.c % 94)) {
      case "j":
        this.d = mem[this.d];
        break;
      case "i":
        this.c = mem[this.d];
        break;
      case "*":
        this.a = mem[this.d] = rotr10(mem[this.d]);
        break;
      case "p":
        this.a = mem[this.d] = crazy10(this.a, mem[this.d]);
        break;
      case "<":
        this.output.push(this.a & 0xff);
        break;
      case "/":
        this.a = this.inputPos < this.input.length ? this.input[this.inputPos++] : 59048;
        break;
      case "v":
        return "halted";
      case "o":
      case "nop":
        break;
    }
    mem[this.c] = encrypt(mem[this.c]);
    this.c = this.c === 59048 ? 0 : this.c + 1;
    this.d = this.d === 59048 ? 0 : this.d + 1;
    this.steps++;
    return "ok";
  }

  run(maxSteps = Infinity): RunResult["status"] {
    while (this.steps < maxSteps) {
      const s = this.step();
      if (s !== "ok") return s;
    }
    return "step-limit";
  }

  outputBytes(): Uint8Array {
    return Uint8Array.from(this.output);
  }

  outputString(): string {
    return String.fromCharCode(...this.output);
  }
}

export function runStandard(source: string, opts: RunOptions = {}): RunResult {
  const m = StandardMachine.fromSource(source, opts.input);
  const status = m.run(opts.maxSteps ?? 50_000_000);
  return { status, output: m.outputString(), outputBytes: m.outputBytes(), steps: m.steps };
}
