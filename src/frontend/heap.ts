import type { IR, Label } from "./ir.js";

/** Bounded bump heap lowered entirely to portable instructions. Addresses are
 * one-based; each aggregate has a length header followed by its values. */
export class Heap {
  private readonly helpers = new Map<string, Label>();
  constructor(private readonly code: IR[], private readonly capacity: number, private readonly slot: () => number) {}
  call(name: "allocate" | "read" | "write" | "index"): void {
    let target = this.helpers.get(name);
    if (!target) { target = { name: `$heap.${name}` }; this.helpers.set(name, target); }
    this.code.push({ op: "call", target });
  }
  finish(): void {
    if (!this.helpers.size) return;
    const cells = Array.from({ length: this.capacity }, () => this.slot());
    const cursor = this.slot(), size = this.slot(), value = this.slot(), base = this.slot(), index = this.slot();
    const fault: Label = { name: "$heap.fault" };
    const emit = (...instructions: IR[]) => this.code.push(...instructions);
    const push = (n: number): IR => ({ op: "push", value: BigInt(n) });
    // Helpers can add dependencies while this map is being traversed.
    for (const [name, label] of this.helpers) {
      emit({ op: "label", label });
      switch (name) {
        case "allocate":
          emit({ op: "store", index: size }, { op: "load", index: cursor }, push(this.capacity),
            { op: "load", index: size }, { op: "sub" }, { op: "le" }, { op: "jz", target: fault },
            { op: "load", index: cursor }, push(1), { op: "add" },
            { op: "load", index: cursor }, { op: "load", index: size }, { op: "add" }, { op: "store", index: cursor }, { op: "ret" });
          break;
        case "index":
          // Check before adding so a large index cannot wrap into a valid cell.
          emit({ op: "store", index }, { op: "store", index: base }, push(0), { op: "load", index },
            { op: "le" }, { op: "jz", target: fault }, { op: "load", index }, { op: "load", index: base });
          this.call("read");
          emit({ op: "lt" }, { op: "jz", target: fault }, { op: "load", index: base },
            push(1), { op: "add" }, { op: "load", index }, { op: "add" }, { op: "ret" });
          break;
        case "write": case "read": {
          if (name === "write") emit({ op: "store", index: value });
          // A balanced dispatch tree gives O(log capacity) indirect access.
          const dispatch = (lo: number, hi: number): void => {
            if (lo === hi) {
              emit({ op: "drop" });
              if (name === "write") emit({ op: "load", index: value }, { op: "store", index: cells[lo - 1] });
              emit({ op: "load", index: name === "write" ? value : cells[lo - 1] }, { op: "ret" });
              return;
            }
            const mid = Math.floor((lo + hi) / 2), right: Label = { name: `$heap.${name}.${mid}` };
            emit({ op: "dup" }, push(mid), { op: "le" }, { op: "jz", target: right });
            dispatch(lo, mid); emit({ op: "label", label: right }); dispatch(mid + 1, hi);
          };
          dispatch(1, this.capacity);
          break;
        }
      }
    }
    // Reuse a portable, deterministic VM fault without extending the ISA.
    emit({ op: "label", label: fault }, push(0), { op: "divi", value: 0n }, { op: "halt" });
  }
}
