import type { BytecodeProgram } from "./isa.js";

/** Prove a fixed depth at each reachable instruction; unknown calls fail closed. */
export function stackBound(program: BytecodeProgram): number | undefined {
  const depths = new Map<number, number>(), pending: [number, number][] = [[0, 0]];
  let bound = 0;
  while (pending.length) {
    const [pc, depth] = pending.pop()!;
    const old = depths.get(pc);
    if (old !== undefined) { if (old !== depth) return; continue; }
    depths.set(pc, depth); bound = Math.max(bound, depth);
    const inst = program.instructions[pc]; if (!inst) continue;
    if (inst.op === "call") return;
    const needs = ["add", "sub", "mul", "div", "mod", "eq", "lt", "le", "swap"].includes(inst.op) ? 2 :
      ["drop", "dup", "store", "jz", "putc", "modi", "divi"].includes(inst.op) ? 1 : 0;
    if (depth < needs) return;
    const delta = ["push", "load", "getc", "dup"].includes(inst.op) ? 1 :
      ["drop", "store", "jz", "putc", "add", "sub", "mul", "div", "mod", "eq", "lt", "le"].includes(inst.op) ? -1 : 0;
    if (inst.op === "jump" || inst.op === "jz") pending.push([inst.target, depth + delta]);
    if (!["halt", "ret", "jump"].includes(inst.op)) pending.push([pc + 1, depth + delta]);
  }
  return bound;
}
