/** Local folding and reachability on validated compiler IR, before relocation. */
import { normalizeWord, wordModulus } from "../vm/isa.js";
import { BOOLEAN } from "./types.js";
import type { IR, Label } from "./ir.js";

export function optimizeIR(input: IR[], width: number): IR[] {
  const modulus = wordModulus(width), norm = (n: bigint) => normalizeWord(n, modulus);
  let code = input;
  for (;;) {
    const out: IR[] = [];
    const locals = new Map<number, bigint>();
    for (let i = 0; i < code.length; i++) {
      const a = code[i], b = code[i + 1], c = code[i + 2];
      if (a.op === "label" || a.op === "call" || a.op === "enter" || a.op === "leave" || a.op === "jump" || a.op === "jz") locals.clear();
      if (a.op === "store") {
        const value = out.at(-1);
        if (value?.op === "push") locals.set(a.index, norm(value.value)); else locals.delete(a.index);
      }
      if (a.op === "load" && locals.has(a.index)) { out.push({ op: "push", value: locals.get(a.index)! }); continue; }
      if (a.op === "push") {
        const x = norm(a.value);
        if (b?.op === "push" && c) {
          const y = norm(b.value);
          let result: bigint | undefined;
          switch (c.op) {
            case "add": result = x + y; break;
            case "sub": result = x - y; break;
            case "mul": result = x * y; break;
            case "div": if (y) result = x / y; break;
            case "mod": if (y) result = x % y; break;
            case "eq": result = BigInt(x === y); break;
            case "lt": result = BigInt(x < y); break;
            case "le": result = BigInt(x <= y); break;
          }
          if (result !== undefined) { out.push({ op: "push", value: norm(result) }); i += 2; continue; }
        }
        if ((b?.op === "divi" || b?.op === "modi") && norm(b.value)) {
          out.push({ op: "push", value: norm(b.op === "divi" ? x / norm(b.value) : x % norm(b.value)) }); i++; continue;
        }
        if (b?.op === "drop") { i++; continue; }
        if (b?.op === "jz") { if (!x) out.push({ op: "jump", target: b.target }); i++; continue; }
        if (b?.op === "print") {
          const text = b.type.kind() === BOOLEAN ? x ? "true" : "false" : x.toString();
          out.push(...Array.from(text, (ch): IR => ({ op: "putci", value: BigInt(ch.codePointAt(0)!) }))); i++; continue;
        }
        // Fuse only existing immediate handlers; never fold invalid Unicode away.
        if (b?.op === "putc") { out.push({ op: "putci", value: x }); i++; continue; }
        if (b?.op === "div" || b?.op === "mod") { out.push({ op: b.op === "div" ? "divi" : "modi", value: x }); i++; continue; }
      }
      if ((a.op === "jump" || a.op === "jz") && b?.op === "label" && a.target === b.label) {
        if (a.op === "jz") out.push({ op: "drop" });
        continue;
      }
      out.push(a);
    }
    if (out.length === code.length && out.every((inst, i) => inst === code[i])) return out;
    code = out;
  }
}

/** Calls retain both callee and continuation; return/stop have no fallthrough. */
export function reachableIR(code: IR[]): IR[] {
  const labels = new Map<Label, number>();
  code.forEach((inst, i) => { if (inst.op === "label") labels.set(inst.label, i); });
  const live = new Set<number>(), pending = [0];
  while (pending.length) {
    const i = pending.pop()!;
    if (i >= code.length || live.has(i)) continue;
    live.add(i); const inst = code[i];
    if ("target" in inst) {
      const target = labels.get(inst.target);
      if (target === undefined) throw new Error(`unresolved compiler label ${inst.target.name}`);
      pending.push(target);
    }
    if (!["jump", "halt", "ret", "leave"].includes(inst.op)) pending.push(i + 1);
  }
  return code.filter((_, i) => live.has(i));
}
