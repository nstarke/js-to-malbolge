/**
 * Interpreter for Malbolge Unshackled (Johansen 2007 semantics).
 * See docs/PLAN.md for a summary of the rules implemented here.
 */
import { decodeOp, encrypt, isValidSourceInstruction, type Mnemonic } from "./tables.js";
import { EOL, MINUS_ONE, ZERO, base, crazy, fromNumber, modClass, next, offsetNumber, rotate, width, type Trits } from "./trits.js";
import { MalbolgeLoadError } from "./standard.js";

/** Decides the rotation width. `grow` is called when D reaches a wider address than before. */
export interface RotationPolicy {
  readonly initialWidth: number;
  grow(currentWidth: number, newMaxDWidth: number): number;
}

/** Never grows. This is the "Unshackled-20" style dialect when w = 20. */
export function fixedWidthPolicy(w: number): RotationPolicy {
  return { initialWidth: w, grow: () => w };
}

/** Grows only as much as the specification requires: rotWidth >= 2 * maxDWidth. */
export function minimalPolicy(initialWidth = 10): RotationPolicy {
  return { initialWidth, grow: (cur, max) => Math.max(cur, 2 * max) };
}

/** Deterministic PRNG (mulberry32) so runs are reproducible from a seed. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mirrors the reference interpreter's randomly selected growth policy:
 * either a deterministic step policy or a probabilistic one.
 */
export function referencePolicy(seed: number): RotationPolicy {
  const rnd = seededRandom(seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const initialWidth = randInt(10, 15);
  const slack = randInt(0, 5);
  if (rnd() < 0.5) {
    const step = randInt(4, 12);
    return {
      initialWidth,
      grow: (cur, max) => (2 * max + slack > cur ? Math.max(2 * max, cur + step) : cur),
    };
  }
  const prob = 0.2 + rnd() * 0.6;
  return {
    initialWidth,
    grow: (cur, max) => {
      const min = 2 * max;
      const will = min > cur ? true : rnd() <= prob;
      return will ? Math.max(min, cur) + randInt(0, slack) : cur;
    },
  };
}

export type UStepStatus = "ok" | "halted" | "hang" | "crash";

export interface URunResult {
  status: "halted" | "hang" | "crash" | "step-limit";
  output: string;
  steps: number;
  crashReason?: string;
  rotWidth: number;
}

export interface URunOptions {
  input?: string;
  maxSteps?: number;
  policy?: RotationPolicy;
}

export interface LoadedProgram {
  /** Program cells, address i holds code at index i. */
  cells: Uint8Array;
  /** Fill values for cells beyond the program, indexed by modClass % 6. */
  rest: Trits[];
}

export function loadUnshackled(source: string): LoadedProgram {
  const codes: number[] = [];
  for (let k = 0; k < source.length; k++) {
    const ch = source[k];
    if (/\s/.test(ch)) continue;
    const code = source.charCodeAt(k);
    const i = codes.length;
    if (code < 33 || code > 126) {
      throw new MalbolgeLoadError(`non-printable character U+${code.toString(16)} at source offset ${k}`, i);
    }
    if (!isValidSourceInstruction(code, i)) {
      throw new MalbolgeLoadError(`invalid instruction '${ch}' at address ${i}`, i);
    }
    codes.push(code);
  }
  const n = codes.length;
  if (n < 2) throw new MalbolgeLoadError("program too short", n);

  // Sequence s0 = second-last char, s1 = last char, s[k+2] = crazy(a = s[k+1], d = s[k]).
  // rest[j] is the sequence value for cells whose address class is j (mod 6).
  const m = n - 2;
  const drop = 2 + ((((4 - m) % 6) + 6) % 6);
  let s0 = fromNumber(codes[n - 2]);
  let s1 = fromNumber(codes[n - 1]);
  const seq: Trits[] = [s0, s1];
  while (seq.length < drop + 6) {
    const s2 = crazy(s1, s0);
    seq.push(s2);
    s0 = s1;
    s1 = s2;
  }
  return { cells: Uint8Array.from(codes), rest: seq.slice(drop, drop + 6) };
}

export class UnshackledMachine {
  a: Trits = ZERO;
  c: Trits = ZERO;
  d: Trits = ZERO;
  rotWidth: number;
  maxDWidth = 0;
  steps = 0;
  crashReason?: string;
  private readonly mem = new Map<Trits, Trits>();
  private readonly rest: Trits[];
  private readonly input: number[];
  private inputPos = 0;
  private readonly out: string[] = [];
  private outputClosed = false;

  constructor(program: LoadedProgram, input = "", public readonly policy: RotationPolicy = minimalPolicy()) {
    this.rest = program.rest;
    for (let i = 0; i < program.cells.length; i++) {
      this.mem.set(fromNumber(i), fromNumber(program.cells[i]));
    }
    this.input = Array.from(input, (ch) => ch.codePointAt(0)!);
    this.rotWidth = policy.initialWidth;
  }

  static fromSource(source: string, input?: string, policy?: RotationPolicy): UnshackledMachine {
    return new UnshackledMachine(loadUnshackled(source), input, policy);
  }

  read(addr: Trits): Trits {
    return this.mem.get(addr) ?? this.rest[modClass(addr) % 6];
  }

  write(addr: Trits, v: Trits): void {
    this.mem.set(addr, v);
  }

  /** Decode the instruction at C, or null if the cell is not executable (hang). */
  private decode(): Mnemonic | null {
    const v = this.read(this.c);
    if (base(v) !== 0 || v.length > 6) return null;
    const off = offsetNumber(v)!;
    if (off < 33 || off > 126) return null;
    return decodeOp(off, modClass(this.c) % 94);
  }

  step(): UStepStatus {
    const op = this.decode();
    if (op === null) return "hang";
    switch (op) {
      case "v":
        return "halted";
      case "i":
        this.c = this.read(this.d);
        break;
      case "<": {
        const a = this.a;
        if (base(a) === 0) {
          const cp = offsetNumber(a);
          if (cp === null || cp > 0x10ffff) return this.crash(`unimplemented output value ${a}`);
          if (this.outputClosed) return this.crash("output after stdout was closed");
          this.out.push(String.fromCodePoint(cp));
        } else if (a === MINUS_ONE) {
          this.outputClosed = true;
        } else if (a === EOL) {
          if (this.outputClosed) return this.crash("output after stdout was closed");
          this.out.push("\n");
        } else {
          return this.crash(`unimplemented output value ${a}`);
        }
        break;
      }
      case "/": {
        if (this.inputPos >= this.input.length) this.a = MINUS_ONE;
        else {
          const cp = this.input[this.inputPos++];
          this.a = cp === 10 ? EOL : fromNumber(cp);
        }
        break;
      }
      case "*": {
        const r = rotate(this.read(this.d), this.rotWidth);
        this.write(this.d, r);
        this.a = r;
        break;
      }
      case "j": {
        const nd = this.read(this.d);
        const w = width(nd);
        if (w > this.maxDWidth) {
          this.rotWidth = this.policy.grow(this.rotWidth, w);
          this.maxDWidth = w;
        }
        this.d = nd;
        break;
      }
      case "p": {
        const r = crazy(this.a, this.read(this.d));
        this.write(this.d, r);
        this.a = r;
        break;
      }
      case "o":
      case "nop":
        break;
    }
    // Encrypt the cell at (possibly new) C, then advance both pointers.
    const cur = this.read(this.c);
    if (base(cur) !== 0 || cur.length > 6) return this.crash(`cannot encrypt cell ${this.c}`);
    const off = offsetNumber(cur)!;
    if (off < 33 || off > 126) return this.crash(`cannot encrypt cell ${this.c} holding ${off}`);
    this.write(this.c, fromNumber(encrypt(off)));
    this.c = next(this.c);
    this.d = next(this.d);
    this.steps++;
    return "ok";
  }

  private crash(reason: string): "crash" {
    this.crashReason = reason;
    return "crash";
  }

  run(maxSteps = Infinity): URunResult["status"] {
    while (this.steps < maxSteps) {
      const s = this.step();
      if (s !== "ok") return s;
    }
    return "step-limit";
  }

  outputString(): string {
    return this.out.join("");
  }
}

export function runUnshackled(source: string, opts: URunOptions = {}): URunResult {
  const m = UnshackledMachine.fromSource(source, opts.input, opts.policy);
  const status = m.run(opts.maxSteps ?? 50_000_000);
  return { status, output: m.outputString(), steps: m.steps, crashReason: m.crashReason, rotWidth: m.rotWidth };
}
