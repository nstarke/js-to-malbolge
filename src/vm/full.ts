/** Bytecode handlers and word arithmetic compiled to shared native microcode. */
import { Arithmetic } from "../hell/arithmetic.js";
import { fixedWord, type RegisterInstruction } from "../hell/init.js";
import { fromBigInt } from "../malbolge/trits.js";
import type { BytecodeProgram } from "./isa.js";
import { encodeBytecode } from "./codec.js";
import { MicroBuilder, type MicroRegister, type MicroLabel, type Frame } from "./micro.js";
import { HELL_VM_FAULTS } from "./faults.js";
import type { HeLLVMOptions } from "./hell.js";

export function planFullHeLLVM(program: BytecodeProgram, options: HeLLVMOptions) {
  return new FullVM(program, options).build();
}

class FullVM {
  private readonly b: MicroBuilder;
  private readonly arithmetic: Arithmetic;
  private readonly neededMath = new Set<string>();
  private readonly modulus: bigint;
  private readonly capacity: number;
  private readonly returnCapacity: number;
  private readonly records: Frame[];
  private readonly stack: Frame[];
  private readonly returns: Frame[];
  private readonly locals: Frame[];
  private readonly pc: MicroRegister;
  private readonly sp: MicroRegister;
  private readonly rp: MicroRegister;
  private readonly value: MicroRegister;
  private readonly lhs: MicroRegister;
  private readonly rhs: MicroRegister;
  private readonly result: MicroRegister;
  private readonly mathReturn: MicroRegister;
  private readonly dispatch: MicroRegister;
  private readonly saved: MicroRegister;
  private readonly popReturn: MicroRegister;
  private readonly pushReturn: MicroRegister;
  private readonly candidate: MicroRegister;
  constructor(private readonly program: BytecodeProgram, options: HeLLVMOptions) {
    this.b = new MicroBuilder(program.width); this.arithmetic = new Arithmetic(program.width, "$arith");
    this.modulus = 3n ** BigInt(program.width);
    this.capacity = options.stackCapacity ?? 16; this.returnCapacity = options.returnStackCapacity ?? 16;
    for (const value of [this.capacity, this.returnCapacity]) if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new RangeError("invalid VM stack capacity");
    const b = this.b;
    this.records = Array.from({ length: program.instructions.length + 1 }, () => b.frame());
    this.stack = Array.from({ length: this.capacity + 2 }, () => b.frame());
    this.returns = Array.from({ length: this.returnCapacity + 2 }, () => b.frame());
    this.locals = Array.from({ length: program.localCount }, () => b.frame());
    this.pc = b.reg("pc", this.records[0].pointer); this.sp = b.reg("sp", this.stack[0].pointer); this.rp = b.reg("rp", this.returns[0].pointer);
    this.value = b.reg("value"); this.lhs = b.reg("math.a"); this.rhs = b.reg("math.b"); this.result = b.reg("math.result");
    this.mathReturn = b.reg("math.return"); this.dispatch = b.reg("dispatch"); this.saved = b.reg("saved");
    this.popReturn = b.reg("pop.return"); this.pushReturn = b.reg("push.return"); this.candidate = b.reg("candidate");
  }
  private label(name: string) { return this.b.label(name); }
  private mark(name: string) { this.b.mark(this.label(name)); }
  private jump(name: string) { this.b.jump(this.label(name)); }
  private number(n: bigint | number) { return this.b.constant(fixedWord(BigInt(n), this.program.width)); }
  private pop(): void {
    const next = this.b.unique("pop.resume"); this.b.set(this.popReturn, next); this.jump("pop"); this.b.mark(next);
  }
  private push(): void {
    const next = this.b.unique("push.resume"); this.b.set(this.pushReturn, next); this.jump("push"); this.b.mark(next);
  }
  private math(op: string, a: MicroRegister, rhs: MicroRegister): void {
    const b = this.b, next = b.unique(`math.${op}.resume`);
    // Arguments may alias the shared input/result registers.
    if (rhs === this.lhs && a !== this.lhs) { const hold = b.reg("math.argument"); b.mov(hold, rhs); rhs = hold; }
    b.mov(this.lhs, a); b.mov(this.rhs, rhs); b.set(this.mathReturn, next); this.neededMath.add(op);
    this.jump(`math.${op}`); b.mark(next);
  }
  private invert(dest: MicroRegister, source: MicroRegister): void {
    const temp = this.b.reg("$not"); this.b.crazy(temp, this.number(2), source); this.b.crazy(dest, temp, this.number(0));
  }
  private trit(dest: MicroRegister, source: MicroRegister, width = this.program.width): void {
    const temp = this.b.reg("$trit"); this.b.crazy(temp, source, this.b.constant(fromBigInt(3n ** BigInt(width) - 2n))); this.b.crazy(dest, temp, this.number(1));
  }
  private shl(dest: MicroRegister): void {
    const temp = this.b.reg("$shift"); this.b.rol(dest);
    this.b.crazy(temp, dest, this.b.constant("21")); this.b.crazy(dest, temp, this.b.constant("01"));
  }
  private translate(instructions: RegisterInstruction[]): void {
    const b = this.b;
    for (const [name, value] of Object.entries(this.arithmetic.registers)) b.reg(name, fixedWord(value, this.program.width));
    for (const inst of instructions) {
      switch (inst.op) {
        case "require-width": break;
        case "copy": b.mov(b.reg(inst.dest), b.reg(inst.source)); break;
        case "crazy": b.crazy(b.reg(inst.dest), b.reg(inst.a), b.reg(inst.b)); break;
        case "rotate":
          if ((inst.count ?? 1) !== this.program.width - 1) throw new Error("arithmetic requires an unsupported logical rotation");
          b.rol(b.reg(inst.dest)); break;
        default: throw new Error(`unsupported arithmetic micro operation ${inst.op}`);
      }
    }
  }
  build() {
    const b = this.b;
    this.mark("fetch"); b.get(this.dispatch, this.pc, 0); b.ijump(this.dispatch);
    this.mark("advance"); b.get(this.pc, this.pc, 2); this.jump("fetch");
    this.mark("pop"); b.get(this.dispatch, this.sp, 4); b.ijump(this.dispatch);
    this.mark("pop.read"); b.get(this.value, this.sp, 0); b.get(this.sp, this.sp, 1); b.ijump(this.popReturn);
    this.mark("push"); b.get(this.candidate, this.sp, 2); b.get(this.dispatch, this.candidate, 3); b.ijump(this.dispatch);
    this.mark("push.write"); b.put(this.candidate, 0, this.value); b.mov(this.sp, this.candidate); b.ijump(this.pushReturn);
    const ops = new Set(this.program.instructions.map((i) => i.op));
    for (const op of ops) { this.mark(`op.${op}`); this.opcode(op); }
    // Math routines register their dependencies as they are emitted.
    for (const op of this.neededMath) { this.mark(`math.${op}`); this.mathBody(op); }
    for (const name of Object.keys(HELL_VM_FAULTS)) { this.mark(`fault.${name}`); b.emit(`fault.${name}`); }
    this.program.instructions.forEach((inst, pc) => {
      const operand = inst.op === "push" ? fixedWord(inst.value, this.program.width) :
        "index" in inst ? this.locals[inst.index].pointer : "target" in inst ? this.records[inst.target].pointer : "0";
      b.fill(this.records[pc], [this.label(`op.${inst.op}`), operand, this.records[pc + 1].pointer]);
    });
    b.fill(this.records.at(-1)!, [this.label("fault.fellOffProgram")]);
    this.locals.forEach((f) => b.fill(f, ["0"]));
    this.stack.forEach((f, i) => b.fill(f, ["0", this.stack[Math.max(0, i - 1)].pointer, this.stack[Math.min(this.stack.length - 1, i + 1)].pointer,
      this.label(i > this.capacity ? "fault.stackOverflow" : "push.write"), this.label(i === 0 ? "fault.stackUnderflow" : "pop.read")]));
    this.returns.forEach((f, i) => b.fill(f, ["0", this.returns[Math.max(0, i - 1)].pointer, this.returns[Math.min(this.returns.length - 1, i + 1)].pointer,
      this.label(i > this.returnCapacity ? "fault.returnStackOverflow" : ops.has("call") ? "call.write" : "fault.none"),
      this.label(i === 0 ? "fault.returnStackUnderflow" : ops.has("ret") ? "ret.read" : "fault.none")]));
    const plan = b.finish(this.label("fetch"), HELL_VM_FAULTS);
    const symbols = new Map([...b.registers].map(([name, reg]) => [name, reg.frame.fields[0]]));
    return {
      ...plan, kind: "microcode" as const, program: this.program, bytecode: encodeBytecode(this.program),
      records: this.records, stack: this.stack, returnStack: this.returns, locals: this.locals, empty: this.stack[0], symbols,
      handlers: new Map([...ops].map((op) => [op, plan.microLabels.get(`op.${op}`)!])),
      stackCapacity: this.capacity, returnStackCapacity: this.returnCapacity, microcode: b,
    };
  }
  private opcode(op: string): void {
    const b = this.b, val = this.value;
    switch (op) {
      case "halt": this.jump("fault.none"); return;
      case "push": b.get(val, this.pc, 1); this.push(); break;
      case "drop": this.pop(); break;
      case "dup": this.pop(); this.push(); this.push(); break;
      case "swap":
        this.pop(); b.mov(this.saved, val); this.pop(); b.mov(b.reg("swap.second"), val);
        b.mov(val, this.saved); this.push(); b.mov(val, b.reg("swap.second")); this.push(); break;
      case "load": b.get(this.saved, this.pc, 1); b.get(val, this.saved, 0); this.push(); break;
      case "store": this.pop(); b.get(this.saved, this.pc, 1); b.put(this.saved, 0, val); break;
      case "jump": b.get(this.pc, this.pc, 1); this.jump("fetch"); return;
      case "jz": {
        this.pop(); this.math("ult", val, this.number(1));
        b.jz(this.result, this.label("advance")); b.get(this.pc, this.pc, 1); this.jump("fetch"); return;
      }
      case "call":
        b.get(this.candidate, this.rp, 2); b.get(this.dispatch, this.candidate, 3); b.ijump(this.dispatch);
        this.mark("call.write"); b.get(this.saved, this.pc, 2); b.put(this.candidate, 0, this.saved); b.mov(this.rp, this.candidate);
        b.get(this.pc, this.pc, 1); this.jump("fetch"); return;
      case "ret":
        b.get(this.dispatch, this.rp, 4); b.ijump(this.dispatch); this.mark("ret.read");
        b.get(this.pc, this.rp, 0); b.get(this.rp, this.rp, 1); this.jump("fetch"); return;
      case "putc": this.output(); break;
      case "getc": this.input(); break;
      case "add": case "sub": case "mul": case "div": case "mod": case "eq": case "lt": case "le":
        this.pop(); b.mov(this.saved, val); this.pop();
        this.math(op === "le" ? "lt" : op, op === "le" ? this.saved : val, op === "le" ? val : this.saved);
        if (op === "le") this.invert(this.result, this.result);
        b.mov(val, this.result); this.push(); break;
      default: throw new Error(`unsupported native opcode ${op}`);
    }
    this.jump("advance");
  }
  private output(): void {
    const b = this.b, positive = b.unique("output.positive"), scalar = b.unique("output.scalar");
    this.pop(); this.math("ult", this.value, this.number((this.modulus + 1n) / 2n));
    b.jz(this.result, this.label("fault.invalidOutput")); b.mark(positive);
    if ((this.modulus - 1n) / 2n > 0x10ffffn) {
      this.math("ult", this.value, this.number(0x110000)); b.jz(this.result, this.label("fault.invalidOutput"));
    }
    if ((this.modulus - 1n) / 2n >= 0xd800n) {
      this.math("ult", this.value, this.number(0xd800)); b.jz(this.result, this.label("output.surrogate")); b.jump(scalar);
      this.mark("output.surrogate"); this.math("ult", this.value, this.number(0xe000)); b.jz(this.result, scalar); this.jump("fault.invalidOutput");
    }
    b.mark(scalar); b.emit("out", this.value);
  }
  private input(): void {
    const b = this.b, flag = b.reg("input.flag"), digit = b.reg("input.digit"), scan = b.reg("input.scan");
    const normal = b.unique("input.normal"), ready = b.unique("input.ready"), newline = b.unique("input.newline"), eof = b.unique("input.eof");
    b.emit("in", this.value, flag); b.jz(flag, normal);
    this.trit(digit, this.value, 20); b.branch3(digit, eof, newline, eof);
    b.mark(eof); b.mov(this.value, this.number(-1)); b.jump(ready);
    b.mark(newline); b.mov(this.value, this.number(10)); b.jump(ready);
    b.mark(normal);
    if (this.program.width < 14) {
      b.mov(scan, this.value);
      for (let i = 0; i < 14; i++) {
        if (i >= this.program.width) {
          this.trit(digit, scan, 20); const valid = b.unique("input.high-zero"); b.jz(digit, valid); this.jump("fault.invalidInput"); b.mark(valid);
        }
        b.rotate(scan); b.clip(scan, b.constant(fromBigInt(3n ** 20n - 1n)));
      }
    }
    this.math("ult", this.value, this.number((this.modulus + 1n) / 2n)); b.jz(this.result, this.label("fault.invalidInput"));
    b.mark(ready); this.push();
  }
  private mathBody(op: string): void {
    const b = this.b;
    if (["add", "sub", "ult"].includes(op)) {
      const parts = this.arithmetic.loop("math.result", "math.a", "math.b", op as "add" | "sub" | "ult");
      this.translate(parts.setup); this.wordLoop(`arithmetic.${op}`, () => this.translate(parts.body)); this.translate(parts.finish);
      b.ijump(this.mathReturn); return;
    }
    if (op === "eq") {
      const ret = b.reg("eq.return"); b.mov(ret, this.mathReturn);
      this.math("sub", this.lhs, this.rhs); this.math("ult", this.result, this.number(1)); b.ijump(ret); return;
    }
    if (op === "lt") {
      const ret = b.reg("lt.return"), left = b.reg("lt.left"), right = b.reg("lt.right");
      b.mov(ret, this.mathReturn); b.mov(left, this.lhs); b.mov(right, this.rhs);
      this.math("add", left, this.number((this.modulus - 1n) / 2n)); b.mov(left, this.result);
      this.math("add", right, this.number((this.modulus - 1n) / 2n)); b.mov(right, this.result);
      this.math("ult", left, right); b.ijump(ret); return;
    }
    if (op === "mul") {
      const ret = b.reg("mul.return"), x = b.reg("mul.x"), y = b.reg("mul.y"), product = b.reg("mul.product"), digit = b.reg("mul.digit"), twice = b.reg("mul.twice");
      b.mov(ret, this.mathReturn); b.mov(x, this.lhs); b.mov(y, this.rhs); b.mov(product, this.number(0));
      this.wordLoop("mul", () => {
        const skip = b.unique("mul.skip"), once = b.unique("mul.once"), two = b.unique("mul.two"), add = b.unique("mul.add");
        this.trit(digit, y); b.branch3(digit, skip, once, two);
        b.mark(once); b.mov(twice, this.number(0)); b.jump(add);
        b.mark(two); b.mov(twice, this.number(1)); b.mark(add);
        this.math("add", product, x); b.mov(product, this.result); b.jz(twice, skip);
        this.math("add", product, x); b.mov(product, this.result);
        b.mark(skip); this.shl(x); b.rotate(y); b.clip(y, this.number(this.modulus - 1n));
      });
      b.mov(this.result, product); b.ijump(ret); return;
    }
    if (op === "div" || op === "mod") {
      b.mov(b.reg("division.mode"), this.number(op === "mod" ? 1 : 0)); this.neededMath.add("division"); this.jump("math.division"); return;
    }
    if (op === "division") { this.division(); return; }
    throw new Error(`native arithmetic ${op} is not implemented`);
  }
  /** Counted word scans use a linked counter, with no recursive arithmetic call. */
  private wordLoop(name: string, body: () => void): void {
    const b = this.b, counter = b.reg(`${name}.counter`), check = b.unique(`${name}.check`), step = b.unique(`${name}.step`), done = b.unique(`${name}.done`);
    const frames = Array.from({ length: this.program.width + 1 }, () => b.frame());
    frames.forEach((frame, i) => b.fill(frame, [frames[Math.min(i + 1, frames.length - 1)].pointer, i === this.program.width ? done : step]));
    b.set(counter, frames[0].pointer); b.mark(check); b.get(this.dispatch, counter, 1); b.ijump(this.dispatch);
    b.mark(step); body(); b.get(counter, counter, 0); b.jump(check); b.mark(done);
  }
  private division(): void {
    const b = this.b, ret = b.reg("division.return"), x = b.reg("division.x"), y = b.reg("division.y"), quotient = b.reg("division.quotient"), remainder = b.reg("division.remainder");
    const negativeA = b.reg("division.negativeA"), negativeB = b.reg("division.negativeB"), digit = b.reg("division.digit"), sign = b.reg("division.sign");
    const nonzero = b.unique("division.nonzero"), positiveA = b.unique("division.positiveA"), positiveB = b.unique("division.positiveB");
    b.mov(ret, this.mathReturn); b.mov(x, this.lhs); b.mov(y, this.rhs);
    this.math("ult", y, this.number(1)); b.jz(this.result, nonzero); this.jump("fault.divisionByZero"); b.mark(nonzero);
    this.math("ult", x, this.number((this.modulus + 1n) / 2n)); this.invert(negativeA, this.result);
    this.math("ult", y, this.number((this.modulus + 1n) / 2n)); this.invert(negativeB, this.result);
    b.jz(negativeA, positiveA); this.math("sub", this.number(0), x); b.mov(x, this.result); b.mark(positiveA);
    b.jz(negativeB, positiveB); this.math("sub", this.number(0), y); b.mov(y, this.result); b.mark(positiveB);
    b.mov(quotient, this.number(0)); b.mov(remainder, this.number(0));
    this.wordLoop("division", () => {
      // Scan the dividend from its most significant trit. The remainder is
      // bounded by the dividend prefix, so these shifts cannot overflow.
      b.rol(x); this.trit(digit, x);
      const temp = b.reg("division.shift"); b.crazy(temp, x, b.constant("21")); b.crazy(x, temp, b.constant("01"));
      this.shl(remainder); this.math("add", remainder, digit); b.mov(remainder, this.result); this.shl(quotient);
      const check = b.unique("division.subtract-check"), subtract = b.unique("division.subtract"), done = b.unique("division.next-trit");
      b.mark(check); this.math("ult", remainder, y); b.jz(this.result, subtract); b.jump(done);
      b.mark(subtract); this.math("sub", remainder, y); b.mov(remainder, this.result);
      this.math("add", quotient, this.number(1)); b.mov(quotient, this.result); b.jump(check); b.mark(done);
    });
    const useQuotient = b.unique("division.use-quotient"), selected = b.unique("division.selected"), positiveLeft = b.unique("division.positive-left"), signed = b.unique("division.signed");
    b.jz(b.reg("division.mode"), useQuotient); b.mov(this.result, remainder); b.mov(sign, negativeA); b.jump(selected);
    b.mark(useQuotient); b.mov(this.result, quotient);
    b.jz(negativeA, positiveLeft); this.invert(sign, negativeB); b.jump(selected);
    b.mark(positiveLeft); b.mov(sign, negativeB); b.mark(selected);
    b.jz(sign, signed); this.math("sub", this.number(0), this.result); b.mark(signed); b.ijump(ret);
  }
}
