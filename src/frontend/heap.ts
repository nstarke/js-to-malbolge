import type { IR, Label } from "./ir.js";

type Operation = "allocate" | "index" | "get" | "set" | "push" | "pop" | "root-add" | "root-drop";
type Field = "data" | "next" | "tag" | "used" | "mark" | "roots";
type Expr = () => void;

/** Stable linked cells, precise roots, and a nonmoving mark/sweep collector.
 * A header stores the length and links to the first payload cell. Tags are
 * -1 for uninitialized payloads, 0 for scalars, and 1 for aggregate references.
 * Root counts track frontend-held references only; tracing handles heap edges
 * and cycles. Metadata is separate from the user-visible logical cell budget.
 * Everything, including collection, lowers to the existing portable ISA. */
export class Heap {
  private readonly helpers = new Map<string, Label>();
  constructor(private readonly code: IR[], private readonly capacity: number, private readonly slot: () => number) {}
  private target(name: string): Label {
    let target = this.helpers.get(name);
    if (!target) { target = { name: `$heap.${name}` }; this.helpers.set(name, target); }
    return target;
  }
  call(name: Operation): void { this.code.push({ op: "call", target: this.target(name) }); }

  /** Saved recursive activations retain their root counts while their local
   * cells are reused. Runtime scratch cells never participate in this pass. */
  instrument(references: Set<number>): void {
    if (!references.size && !this.helpers.size) return;
    const output: IR[] = [];
    const call = (name: Operation) => output.push({ op: "call", target: this.target(name) });
    const store = (index: number) => {
      if (references.has(index)) { output.push({ op: "load", index }); call("root-drop"); }
      output.push({ op: "store", index });
      if (references.has(index)) { output.push({ op: "load", index }); call("root-add"); }
    };
    for (const inst of this.code) {
      if (inst.op === "store") store(inst.index);
      else if (inst.op === "enter") {
        const { slots, params, incoming } = inst.frame;
        for (const index of [...incoming].reverse()) output.push({ op: "store", index });
        for (const index of slots) {
          output.push({ op: "load", index });
          if (references.has(index)) output.push({ op: "push", value: 0n }, { op: "store", index });
        }
        params.forEach((index, i) => { output.push({ op: "load", index: incoming[i] }); store(index); });
      } else if (inst.op === "leave") {
        for (const index of [...inst.frame.slots].reverse()) {
          output.push({ op: "swap" });
          if (references.has(index)) { output.push({ op: "load", index }); call("root-drop"); }
          output.push({ op: "store", index });
        }
        output.push({ op: "ret" });
      } else output.push(inst);
    }
    this.code.length = 0;
    for (const inst of output) this.code.push(inst);
  }

  finish(): void {
    if (!this.helpers.size) return;
    const fields = new Map<Field, number[]>();
    for (const field of ["data", "next", "tag", "used", "mark", "roots"] as const) {
      fields.set(field, Array.from({ length: this.capacity }, () => this.slot()));
    }
    const free = this.slot();
    this.code.unshift({ op: "push", value: BigInt(this.capacity) }, { op: "store", index: free });
    const fault = this.target("fault");
    const emit = (...instructions: IR[]) => { for (const inst of instructions) this.code.push(inst); };
    const lit = (n: number): Expr => () => emit({ op: "push", value: BigInt(n) });
    const load = (index: number): Expr => () => emit({ op: "load", index });
    const save = (index: number, value: Expr) => { value(); emit({ op: "store", index }); };
    const bin = (op: "add" | "sub" | "eq" | "lt" | "le", a: Expr, b: Expr): Expr => () => { a(); b(); emit({ op }); };
    const invoke = (name: string, ...args: Expr[]): Expr => () => { args.forEach((arg) => arg()); emit({ op: "call", target: this.target(name) }); };
    const get = (field: Field, at: Expr) => invoke(`read.${field}`, at);
    const set = (field: Field, at: Expr, value: Expr) => invoke(`write.${field}`, at, value)();
    let serial = 0;
    const label = (): Label => ({ name: `$heap.block.${serial++}` });
    const when = (test: Expr, yes: () => void, no?: () => void) => {
      const other = label(), done = label(); test(); emit({ op: "jz", target: other }); yes();
      emit({ op: "jump", target: done }, { op: "label", label: other }); no?.(); emit({ op: "label", label: done });
    };
    const loop = (test: Expr, body: () => void) => {
      const start = label(), done = label(); emit({ op: "label", label: start }); test();
      emit({ op: "jz", target: done }); body(); emit({ op: "jump", target: start }, { op: "label", label: done });
    };
    const check = (test: Expr) => { test(); emit({ op: "jz", target: fault }); };
    const ret = (value?: Expr) => { value?.(); emit({ op: "ret" }); };
    const args = (count: number): number[] => {
      const slots = Array.from({ length: count }, () => this.slot());
      for (const index of [...slots].reverse()) emit({ op: "store", index });
      return slots;
    };
    const scan = (body: (at: Expr) => void) => {
      const i = this.slot(); save(i, lit(1));
      loop(bin("le", load(i), lit(this.capacity)), () => { body(load(i)); save(i, bin("add", load(i), lit(1))); });
    };
    // Calls append dependencies to this map as routines are generated.
    for (const [name, entry] of this.helpers) {
      emit({ op: "label", label: entry });
      if (name === "fault") { lit(0)(); emit({ op: "divi", value: 0n }, { op: "halt" }); continue; }
      if (name.startsWith("read.") || name.startsWith("write.")) {
        const write = name.startsWith("write."), cells = fields.get(name.split(".")[1] as Field)!;
        const value = write ? args(1)[0] : -1;
        const dispatch = (lo: number, hi: number): void => {
          if (lo === hi) {
            emit({ op: "drop" });
            if (write) save(cells[lo - 1], load(value));
            ret(write ? undefined : load(cells[lo - 1])); return;
          }
          const mid = Math.floor((lo + hi) / 2), right = label();
          emit({ op: "dup" }); lit(mid)(); emit({ op: "le" }, { op: "jz", target: right });
          dispatch(lo, mid); emit({ op: "label", label: right }); dispatch(mid + 1, hi);
        };
        dispatch(1, this.capacity); continue;
      }
      switch (name) {
        case "root-add": case "root-drop": {
          const [at] = args(1), count = this.slot();
          when(load(at), () => {
            save(count, get("roots", load(at)));
            if (name === "root-drop") check(bin("lt", lit(0), load(count)));
            save(count, bin(name === "root-add" ? "add" : "sub", load(count), lit(1)));
            if (name === "root-add") check(bin("lt", lit(0), load(count))); // fail before counter wrap can lose a root
            set("roots", load(at), load(count));
          });
          ret(); break;
        }
        case "collect": {
          const changed = this.slot();
          scan((at) => set("mark", at, bin("lt", lit(0), get("roots", at))));
          save(changed, lit(1));
          loop(load(changed), () => {
            save(changed, lit(0));
            const mark = (value: Expr) => {
              const at = this.slot(); save(at, value);
              when(load(at), () => when(bin("eq", get("mark", load(at)), lit(0)), () => {
                set("mark", load(at), lit(1)); save(changed, lit(1));
              }));
            };
            scan((at) => when(get("mark", at), () => {
              mark(get("next", at));
              when(bin("eq", get("tag", at), lit(1)), () => mark(get("data", at)));
            }));
          });
          save(free, lit(0));
          scan((at) => when(bin("eq", get("mark", at), lit(0)), () => {
            set("used", at, lit(0)); set("data", at, lit(0)); set("next", at, lit(0)); set("tag", at, lit(-1));
            save(free, bin("add", load(free), lit(1)));
          }));
          ret(); break;
        }
        case "reserve": {
          const [n] = args(1), head = this.slot(), tail = this.slot(), i = this.slot();
          check(bin("le", load(n), lit(this.capacity)));
          when(bin("lt", load(free), load(n)), () => invoke("collect")());
          check(bin("le", load(n), load(free)));
          save(head, lit(0)); save(tail, lit(0)); save(i, lit(1));
          loop(load(n), () => {
            when(bin("eq", get("used", load(i)), lit(0)), () => {
              set("used", load(i), lit(1)); set("next", load(i), lit(0)); set("tag", load(i), lit(-1)); set("data", load(i), lit(0));
              when(load(tail), () => set("next", load(tail), load(i)), () => save(head, load(i)));
              save(tail, load(i)); save(n, bin("sub", load(n), lit(1))); save(free, bin("sub", load(free), lit(1)));
            });
            save(i, bin("add", load(i), lit(1)));
          });
          ret(load(head)); break;
        }
        case "allocate": {
          const [n] = args(1), at = this.slot();
          save(at, invoke("reserve", load(n)));
          set("data", load(at), bin("sub", load(n), lit(1))); set("tag", load(at), lit(0));
          ret(load(at)); break;
        }
        case "index": {
          const [index] = args(1);
          check(bin("le", lit(0), load(index))); check(bin("lt", load(index), lit(this.capacity - 1)));
          ret(load(index)); break;
        }
        case "cell": {
          // -1 selects the length header; nonnegative indices select elements.
          const [at, index] = args(2);
          check(bin("le", lit(-1), load(index)));
          check(bin("lt", load(index), get("data", load(at))));
          loop(bin("le", lit(0), load(index)), () => {
            save(at, get("next", load(at))); save(index, bin("sub", load(index), lit(1)));
          });
          ret(load(at)); break;
        }
        case "get": {
          const [base, index] = args(2), at = this.slot();
          save(at, invoke("cell", load(base), load(index)));
          check(bin("le", lit(0), get("tag", load(at))));
          ret(get("data", load(at))); break;
        }
        case "resize": {
          const [at, length] = args(2), old = this.slot(), tail = this.slot(), added = this.slot();
          check(bin("le", lit(0), load(length))); check(bin("lt", load(length), lit(this.capacity)));
          save(old, get("data", load(at)));
          when(bin("lt", load(old), load(length)), () => {
            // The receiver is pinned by the frontend while reserve may collect.
            save(added, invoke("reserve", bin("sub", load(length), load(old))));
            save(tail, invoke("cell", load(at), bin("sub", load(old), lit(1))));
            set("next", load(tail), load(added));
          }, () => {
            save(tail, invoke("cell", load(at), bin("sub", load(length), lit(1))));
            set("next", load(tail), lit(0)); // detached elements become collectible
          });
          set("data", load(at), load(length)); ret(); break;
        }
        case "set": {
          const [at, index, value, tag] = args(4), cell = this.slot();
          when(bin("eq", load(index), lit(-1)), () => invoke("resize", load(at), load(value))(), () => {
            check(bin("le", lit(0), load(index))); check(bin("lt", load(index), lit(this.capacity - 1)));
            when(bin("le", get("data", load(at)), load(index)), () => invoke("resize", load(at), bin("add", load(index), lit(1)))());
            save(cell, invoke("cell", load(at), load(index)));
            set("data", load(cell), load(value)); set("tag", load(cell), load(tag));
          });
          ret(load(value)); break;
        }
        case "push": {
          const [at, value, tag] = args(3);
          invoke("set", load(at), get("data", load(at)), load(value), load(tag))(); emit({ op: "drop" });
          ret(get("data", load(at))); break;
        }
        case "pop": {
          const [at] = args(1), length = this.slot(), value = this.slot();
          save(length, bin("sub", get("data", load(at)), lit(1)));
          check(bin("le", lit(0), load(length)));
          save(value, invoke("get", load(at), load(length)));
          invoke("resize", load(at), load(length))(); ret(load(value)); break;
        }
        default: throw new Error(`unknown heap helper ${name}`);
      }
    }
  }
}
