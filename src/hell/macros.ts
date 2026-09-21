/** Small, rotation-independent building blocks for the arithmetic runtime. */
import { canon, crazy, fromNumber, type Trits } from "../malbolge/trits.js";
import { isValidAt, restorableValue } from "./cycles.js";
import { constant, type CodeBlock, type Visit } from "./ir.js";

/**
 * Load 0..80 into A, starting from a known accumulator value. The returned
 * visits consume fresh operand cells; these are straight-line macros, not
 * reusable register stores. The assembler supplies block restore visits.
 *
 * Pin `block.address` in the program: a chain valid for P at 81 need not be
 * valid for P at 85. Plain entry preserves A=0; double-j patching does not.
 * Values >=81 require rotation or a suitable initial accumulator and belong
 * to the forthcoming wide-constant initializer.
 */
export function loadConstant(block: CodeBlock, from: Trits, value: number): Visit[] {
  const pointer = block.address;
  if (block.op !== "p" || pointer === undefined || !Number.isInteger(pointer) ||
      pointer < 33 || pointer > 126 || restorableValue("p", pointer + 1) === null) {
    throw new RangeError("loadConstant requires a p block pinned at a legal address");
  }
  if (!Number.isInteger(value) || value < 0 || value > 80) {
    throw new RangeError("loadConstant supports integers from 0 through 80");
  }
  if (!/^[012]{1,6}$/.test(from)) {
    throw new RangeError("initial accumulator must contain at most five trits and a repeating base");
  }
  // Only operand values that can immediately follow this P pointer are legal.
  const constants: number[] = [];
  for (let c = 33; c <= 126; c++) {
    for (let addr = 0; addr < 94; addr++) {
      if (isValidAt(pointer, addr) && isValidAt(c, addr + 1)) {
        constants.push(c);
        break;
      }
    }
  }
  const target = fromNumber(value);
  // Canonicalize through the same representation used by crazy().
  from = canon(from);
  if (from === target) return [];
  const previous = new Map<Trits, { from: Trits; constant: number } | null>([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    for (const c of constants) {
      const next = crazy(a, fromNumber(c));
      if (previous.has(next)) continue;
      previous.set(next, { from: a, constant: c });
      if (next === target) {
        const visits: Visit[] = [];
        let cursor = next;
        while (cursor !== from) {
          const step = previous.get(cursor)!;
          visits.push({ block: block.label, operand: constant(step.constant) });
          cursor = step.from;
        }
        return visits.reverse();
      }
      queue.push(next);
    }
  }
  throw new RangeError(`cannot load ${value} from accumulator ${from} without rotation`);
}
