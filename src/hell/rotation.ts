/** Rotation-width-independent cycle detection, for an already installed loop. */
import type { AccumulatorInstruction, AccumulatorLoop } from "./control.js";
import type { InitialValue } from "./init.js";

/**
 * Execute `step` once per physical rotation, stopping when a one-trit marker
 * returns to position 1. Neither this body nor its selector depends on width.
 * The physical width must stay stable during the cycle. Installing its code
 * with planAccumulatorLoop/assembleRegisters still needs a known width.
 */
export function rotationCycle(
  registers: Record<string, InitialValue> = {},
  step: AccumulatorInstruction[] = [],
  prefix = "rotation",
): Omit<AccumulatorLoop, "width"> {
  const initial: Record<string, InitialValue> = {
    ones: "1", six: 6, three: 3, marker: 3, mask: "1", copy: "1",
    test: 0, d6: 6, d3: 3, z0: 0, z1: 0,
  };
  const name = (key: string) => `${prefix}.${key}`;
  for (const key of Object.keys(initial)) if (name(key) in registers) throw new RangeError(`reserved rotation register ${name(key)}`);
  for (const inst of step) if (!Object.hasOwn(registers, inst.register)) throw new RangeError(`unknown rotation payload register ${inst.register}`);
  const body: AccumulatorInstruction[] = [];
  const emit = (op: AccumulatorInstruction["op"], key: string, count = 1) => {
    for (let i = 0; i < count; i++) body.push({ op, register: name(key) });
  };
  const reset = (key: string, zero = false) => { emit("*", "ones"); emit("p", key, zero ? 3 : 2); };
  // A=...111 reads a word consisting only of 0/2 trits without changing it.
  const six = () => { emit("*", "ones"); emit("p", "six"); };
  const three = () => {
    // A=...1121 (trit 1 is 2) swaps 1/2 at position 1 and leaves
    // all other zero trits zero. Applying it twice reads 3 nondestructively.
    for (let i = 0; i < 2; i++) {
      reset("mask"); six(); emit("p", "mask"); emit("p", "three");
    }
  };
  const copy = (dest: string, source: "six" | "three") => {
    reset(dest); reset("copy");
    if (source === "six") six(); else three();
    emit("p", "copy"); emit("p", dest);
  };
  reset("test", true); copy("d6", "six"); copy("d3", "three"); reset("z0", true); reset("z1", true);
  body.push(...step);
  emit("*", "marker"); emit("p", "test"); six(); emit("p", "test");
  // The test has base 1, trit 1 = 0 on return, 2 otherwise. These four
  // crazy operations turn it into ...111 (stop) or ...101 (continue).
  emit("p", "d6"); emit("p", "d3"); emit("p", "z0"); emit("p", "z1");
  return { registers: { ...registers, ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [name(k), v])) }, body, condition: "selector" };
}
