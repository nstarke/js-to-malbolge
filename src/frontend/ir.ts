import { type Instruction, type BytecodeProgram, validateBytecodeProgram } from "../vm/isa.js";
import { optimizeIR, reachableIR } from "./optimize.js";
import { BOOLEAN, SCALAR, type ValueType } from "./types.js";

export interface Label { readonly name: string }
export interface Frame { slots: number[]; params: number[]; incoming: number[] }
type BranchOp = "jump" | "jz" | "call";
export type IR = Exclude<Instruction, { target: number }> |
  { op: BranchOp; target: Label } |
  { op: "label"; label: Label } |
  { op: "enter" | "leave"; frame: Frame } |
  { op: "print"; type: ValueType } |
  { op: "strict-eq"; left: ValueType; right: ValueType; loose?: boolean };

/** Expand frame operations and output helpers, then resolve symbolic branches. */
export function lowerIR(ir: IR[], width: number, localCount: number, optimize = true): BytecodeProgram {
  if (optimize) {
    ir = reachableIR(optimizeIR(ir, width));
    const read = new Set(ir.flatMap((inst) => inst.op === "load" ? [inst.index] : inst.op === "enter" || inst.op === "leave" ? inst.frame.slots : []));
    ir = optimizeIR(ir.map((inst) => inst.op === "store" && !read.has(inst.index) ? { op: "drop" } : inst), width);
  }
  type ResolvedIR = Exclude<IR, { op: "enter" | "leave" | "print" | "strict-eq" }>;
  const out: ResolvedIR[] = [];
  const decimal: Label = { name: "$print.unsigned" };
  let needsDecimal = false;
  const text = (value: string) => {
    for (const ch of value) out.push({ op: "putci", value: BigInt(ch.codePointAt(0)!) });
  };
  for (const inst of ir) {
    switch (inst.op) {
      case "enter": {
        // Arguments are consumed before saving the old frame. This preserves
        // side effects in recursive call arguments such as recurse(n--).
        const { slots, params, incoming } = inst.frame;
        for (const index of [...incoming].reverse()) out.push({ op: "store", index });
        for (const index of slots) out.push({ op: "load", index });
        for (let i = 0; i < params.length; i++) out.push({ op: "load", index: incoming[i] }, { op: "store", index: params[i] });
        break;
      }
      case "leave":
        // The return value stays above the restored activation's saved locals.
        for (const index of [...inst.frame.slots].reverse()) out.push({ op: "swap" }, { op: "store", index });
        out.push({ op: "ret" });
        break;
      case "strict-eq":
        if (inst.left.kind() === inst.right.kind() || inst.loose && (inst.left.kind() & SCALAR) && (inst.right.kind() & SCALAR)) out.push({ op: "eq" });
        else out.push({ op: "drop" }, { op: "drop" }, { op: "push", value: 0n });
        break;
      case "print": {
        const alternate: Label = { name: "$print.alternate" }, done: Label = { name: "$print.done" };
        if (inst.type.kind() === BOOLEAN) {
          out.push({ op: "jz", target: alternate }); text("true");
          out.push({ op: "jump", target: done }, { op: "label", label: alternate }); text("false");
          out.push({ op: "label", label: done });
        } else {
          out.push({ op: "dup" }, { op: "push", value: 0n }, { op: "lt" }, { op: "jz", target: alternate });
          text("-");
          out.push({ op: "push", value: 0n }, { op: "swap" }, { op: "sub" }, { op: "label", label: alternate }, { op: "call", target: decimal });
          needsDecimal = true;
        }
        break;
      }
      default: out.push(inst);
    }
  }
  if (needsDecimal) {
    const multiple: Label = { name: "$print.multiple" };
    out.push(
      { op: "label", label: decimal }, { op: "dup" }, { op: "push", value: 10n }, { op: "lt" }, { op: "jz", target: multiple },
      { op: "push", value: 48n }, { op: "add" }, { op: "putc" }, { op: "ret" },
      { op: "label", label: multiple }, { op: "dup" }, { op: "divi", value: 10n }, { op: "call", target: decimal },
      { op: "modi", value: 10n }, { op: "push", value: 48n }, { op: "add" }, { op: "putc" }, { op: "ret" },
    );
  }
  const final = (optimize ? reachableIR(optimizeIR(out, width)) : out) as ResolvedIR[];
  const labels = new Map<Label, number>();
  let pc = 0;
  for (const inst of final) { if (inst.op === "label") labels.set(inst.label, pc); else pc++; }
  const instructions: Instruction[] = [];
  for (const inst of final) {
    if (inst.op === "label") continue;
    if ("target" in inst) {
      const target = labels.get(inst.target);
      if (target === undefined) throw new Error(`unresolved compiler label ${inst.target.name}`);
      instructions.push({ op: inst.op, target });
    } else instructions.push(inst);
  }
  if (optimize) {
    const used = [...new Set(instructions.flatMap((inst) => "index" in inst ? [inst.index] : []))].sort((a, b) => a - b);
    const indices = new Map(used.map((index, i) => [index, i]));
    for (const inst of instructions) if ("index" in inst) inst.index = indices.get(inst.index)!;
    localCount = used.length;
  }
  const program = { instructions, width, localCount };
  validateBytecodeProgram(program);
  return program;
}
