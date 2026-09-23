import type { IR, Label } from "./ir.js";

/** Add a presence word to frontend values without reserving an integer sentinel.
 * Raw heap routines and the VM ISA remain single-word. This pass runs before
 * those routines are appended, adapting their calls at the boundary. */
export function lowerDefinedValues(input: IR[], slot: () => number, heapPresence: () => number, isHeapCall: (target: Label) => boolean): IR[] {
  const code: IR[] = [], tags = new Map<number, number>();
  const valueA = slot(), tagA = slot(), valueB = slot(), tagB = slot();
  const tag = (index: number): number => {
    let found = tags.get(index);
    if (found === undefined) { found = slot(); tags.set(index, found); }
    return found;
  };
  const emit = (...instructions: IR[]) => code.push(...instructions);
  const push = (n: number) => emit({ op: "push", value: BigInt(n) });
  const load = (index: number) => emit({ op: "load", index });
  const store = (index: number) => emit({ op: "store", index });
  const fault: Label = { name: "$undefined.invalid-use" };
  let needsFault = false, serial = 0;
  const label = (): Label => ({ name: `$defined.${serial++}` });
  const check = (index: number) => { needsFault = true; load(index); emit({ op: "jz", target: fault }); };
  const readPair = (value: number, present: number) => { store(present); store(value); };
  const pair = (value: number, present: number) => { load(value); load(present); };
  const when = (test: () => void, yes: () => void, no: () => void) => {
    const other = label(), done = label(); test(); emit({ op: "jz", target: other }); yes();
    emit({ op: "jump", target: done }, { op: "label", label: other }); no(); emit({ op: "label", label: done });
  };
  const text = (value: string) => { for (const ch of value) emit({ op: "putci", value: BigInt(ch.codePointAt(0)!) }); };
  const lower = (inst: IR): void => {
    switch (inst.op) {
      case "undefined": push(0); push(0); break;
      case "push": emit(inst); push(1); break;
      case "load": emit(inst); load(tag(inst.index)); break;
      case "store": store(tag(inst.index)); emit(inst); break;
      case "drop": emit(inst, inst); break;
      case "dup": readPair(valueA, tagA); pair(valueA, tagA); pair(valueA, tagA); break;
      case "swap": readPair(valueB, tagB); readPair(valueA, tagA); pair(valueB, tagB); pair(valueA, tagA); break;
      case "is-defined": store(tagA); emit({ op: "drop" }); load(tagA); push(1); break;
      case "truthy":
        emit({ op: "drop" }); push(0); emit({ op: "eq" }); push(0); emit({ op: "eq" }); push(1); break;
      case "require-defined": store(tagA); check(tagA); load(tagA); break;
      case "jz": emit({ op: "drop" }, inst); break; // undefined has canonical payload zero
      case "modi": case "divi":
        store(tagA); check(tagA); emit(inst); push(1); break;
      case "add": case "sub": case "mul": case "div": case "mod":
        readPair(valueB, tagB); readPair(valueA, tagA); check(tagA); check(tagB);
        load(valueA); load(valueB); emit(inst); push(1); break;
      case "eq": case "lt": case "le": case "strict-eq":
        readPair(valueB, tagB); readPair(valueA, tagA);
        when(() => { load(tagA); load(tagB); emit({ op: "eq" }); }, () => {
          when(() => load(tagA), () => { load(valueA); load(valueB); emit(inst); },
            () => push(inst.op === "eq" || inst.op === "strict-eq" ? 1 : 0));
        }, () => push(0));
        push(1); break;
      case "print":
        store(tagA);
        when(() => load(tagA), () => emit(inst), () => { emit({ op: "drop" }); text("undefined"); });
        break;
      case "call": {
        const name = inst.target.name;
        if (!isHeapCall(inst.target)) { emit(inst); break; }
        const op = name.slice(6);
        const count = op === "set" ? 4 : op === "push" ? 3 : op === "get" ? 2 : 1;
        const values = Array.from({ length: count }, () => slot());
        const present = Array.from({ length: count }, () => slot());
        for (let i = count - 1; i >= 0; i--) readPair(values[i], present[i]);
        if (op !== "root-add" && op !== "root-drop") {
          check(present[0]);
          if (op === "get" || op === "set") check(present[1]);
        }
        if (op === "set" || op === "push") {
          const item = op === "set" ? 2 : 1, flag = count - 1;
          when(() => load(present[item]), () => {}, () => { push(-1); store(values[flag]); });
        }
        values.forEach(load); emit(inst);
        if (op === "get" || op === "pop") load(heapPresence());
        else if (op === "set") load(present[2]);
        else if (op !== "root-add" && op !== "root-drop") push(1);
        break;
      }
      case "enter": {
        const { slots, params, incoming } = inst.frame;
        for (const index of [...incoming].reverse()) lower({ op: "store", index });
        for (const index of slots) lower({ op: "load", index });
        params.forEach((index, i) => { lower({ op: "load", index: incoming[i] }); lower({ op: "store", index }); });
        break;
      }
      case "leave":
        for (const index of [...inst.frame.slots].reverse()) { lower({ op: "swap" }); lower({ op: "store", index }); }
        emit({ op: "ret" }); break;
      default: emit(inst);
    }
  };
  input.forEach(lower);
  if (needsFault) { emit({ op: "label", label: fault }); push(0); emit({ op: "divi", value: 0n }, { op: "halt" }); }
  return code;
}
