/** Reusable word arithmetic expressed entirely as crazy/rotate register instructions. */
import type { InitialValue, RegisterInstruction as I } from "./init.js";
import { fixedWord } from "./init.js";

/** Private register names must be included in the assembled program, once per instance. */
export class Arithmetic {
  readonly registers: Record<string, InitialValue>;
  private readonly n: Record<string, string>;
  constructor(readonly width: number, prefix = "arith") {
    fixedWord(0, width);
    const max = 3n ** BigInt(width) - 1n;
    const values: Record<string, InitialValue> = {
      zero: 0, ones: "1", max, mask0: "01", mask2: "21", one: 1, two: 2,
      extract: max - 1n, half: max / 2n,
      x: 0, y: 0, carry: 0, t0: 0, t1: 0, t2: 0, flag: 0, left: 0, right: 0,
    };
    this.n = Object.fromEntries(Object.keys(values).map((k) => [k, `${prefix}.${k}`]));
    this.registers = Object.fromEntries(Object.entries(values).map(([k, v]) => [this.n[k], v]));
  }
  private c(dest: string, a: string, b: string): I { return { op: "crazy", dest, a, b }; }
  private copy(dest: string, source: string): I { return { op: "copy", dest, source }; }

  /** Extract an unsigned word's trit as the integer 0, 1 or 2. Preserves source. */
  trit(dest: string, source: string, index: number): I[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.width) throw new RangeError("trit index is outside the word");
    const n = this.n;
    return [{ op: "require-width", width: this.width }, this.copy(n.t0, source), { op: "rotate", dest: n.t0, count: index },
      this.c(n.t1, n.t0, n.extract), this.c(dest, n.t1, n.one)];
  }

  /** Modulo 3^width, with arbitrary operand/output aliasing. Preserves other operands. */
  add(dest: string, a: string, b: string): I[] { return this.wordOperation(dest, a, b, false, false); }
  increment(dest: string, source = dest): I[] { return this.add(dest, source, this.n.one); }
  subtract(dest: string, a: string, b: string): I[] { return this.wordOperation(dest, a, b, true, false); }

  /** Form a frame pointer for an in-bounds array index, preserving the index. */
  address(dest: string, array: string, index: string): I[] {
    const n = this.n;
    return [
      { op: "require-width", width: this.width }, this.copy(n.left, index),
      { op: "rotate", dest: n.left, count: this.width - 1 },
      this.c(n.t0, n.left, n.mask2), this.c(n.left, n.t0, n.mask0),
      { op: "array-base", dest: n.right, array }, ...this.add(dest, n.left, n.right),
    ];
  }

  /** Boolean comparison. Signed mode uses the VM's centered signed representation. */
  lessThan(dest: string, a: string, b: string, signed = true): I[] {
    const n = this.n;
    if (!signed) return this.wordOperation(dest, a, b, true, true);
    return [...this.add(n.left, a, n.half), ...this.add(n.right, b, n.half),
      ...this.wordOperation(dest, n.left, n.right, true, true)];
  }

  equal(dest: string, a: string, b: string): I[] {
    const n = this.n;
    const out = this.subtract(n.left, a, b);
    // Nonzero indicator at every trit: C(C(x,0),0).
    out.push(this.c(n.t0, n.left, n.zero), this.c(n.x, n.t0, n.zero));
    // Cyclic doubling covers the whole word, including non-power-of-two widths.
    for (let shift = 1; shift < this.width; shift *= 2) {
      out.push(this.copy(n.y, n.x), { op: "rotate", dest: n.y, count: shift },
        this.c(n.t0, n.max, n.y), this.c(n.t1, n.x, n.t0), this.c(n.x, n.t1, n.t0));
    }
    out.push(...this.trit(n.flag, n.x, 0), this.c(n.t0, n.two, n.flag), this.c(dest, n.t0, n.zero));
    return out;
  }

  private wordOperation(dest: string, a: string, b: string, subtract: boolean, comparison: boolean): I[] {
    const parts = this.operationParts(dest, a, b, subtract, comparison, false);
    return [...parts.setup, ...parts.body, ...parts.finish];
  }

  /** One carry/borrow iteration, for a caller that repeats BODY exactly WIDTH times. */
  loop(dest: string, a: string, b: string, operation: "add" | "sub" | "ult"): { setup: I[]; body: I[]; finish: I[] } {
    return this.operationParts(dest, a, b, operation !== "add", operation === "ult", true);
  }

  private operationParts(dest: string, a: string, b: string, subtract: boolean, comparison: boolean, loop: boolean): { setup: I[]; body: I[]; finish: I[] } {
    const n = this.n;
    const setup: I[] = [{ op: "require-width", width: this.width }, this.copy(n.x, a), this.copy(n.y, b)];
    if (comparison) setup.push(this.copy(n.flag, n.zero));
    const out: I[] = [];
    let y = n.y, carry = n.carry;
    for (let i = 0; i < (loop ? 1 : this.width); i++) {
      if (subtract) {
        // Borrow = a < b, evaluated independently at each trit (leading base=0).
        out.push(this.c(n.t0, n.max, y), this.c(n.t1, n.t0, n.x),
          this.c(n.t0, n.max, n.t1), this.c(carry, n.t0, n.zero));
        // Difference mod 3: C(C(b,C(2,a)),C(a,C(C(2,b),C(0,C(2,a))))).
        out.push(this.c(n.t0, n.max, n.x), this.c(n.t1, y, n.t0),
          this.c(n.t2, n.zero, n.t0), this.c(n.t0, n.max, y),
          this.c(n.t2, n.t0, n.t2), this.c(n.t2, n.x, n.t2), this.c(n.x, n.t1, n.t2));
      } else {
        // Carry = C(C(a,C(b,C(1,C(a,2)))),0). Constant 1 repeats infinitely.
        out.push(this.c(n.t0, n.x, n.max), this.c(n.t0, n.ones, n.t0),
          this.c(n.t0, y, n.t0), this.c(n.t0, n.x, n.t0), this.c(carry, n.t0, n.zero));
        // Sum mod 3: C(C(2,C(a,b)),C(C(b,a),C(b,C(2,b)))).
        out.push(this.c(n.t0, n.x, y), this.c(n.t0, n.max, n.t0),
          this.c(n.t1, y, n.x), this.c(n.t2, n.max, y),
          this.c(n.t2, y, n.t2), this.c(n.t2, n.t1, n.t2), this.c(n.x, n.t0, n.t2));
      }
      out.push({ op: "rotate", dest: carry, count: this.width - 1 });
      if (comparison) {
        // Collect the outgoing borrow before clearing the wrapped low trit.
        out.push(this.c(n.t0, carry, n.extract), this.c(n.t1, n.t0, n.one),
          this.c(n.t0, n.max, n.t1), this.c(n.t1, n.flag, n.t0), this.c(n.flag, n.t1, n.t0));
      }
      // Shift left: rotate left, then force the low trit to zero with two masks.
      out.push(this.c(n.t0, carry, n.mask2), this.c(carry, n.t0, n.mask0));
      if (loop) out.push(this.copy(n.y, carry));
      else [y, carry] = [carry, y];
    }
    return { setup, body: out, finish: [this.copy(dest, comparison ? n.flag : n.x)] };
  }
}
