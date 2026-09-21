import { describe, expect, it } from "vitest";
import { rotationCycle, fixedWord, planAccumulatorLoop, valueForOp, fillerValue } from "../src/hell/index.js";
import { crazy, rotate, fromNumber } from "../src/malbolge/trits.js";
import { UnshackledMachine, fixedWidthPolicy } from "../src/malbolge/unshackled.js";

describe("width-independent rotation cycle", () => {
  it.each([10, 11, 13, 15, 20, 31, 64, 127])("detects a complete cycle without knowing physical width %i", (width) => {
    const cycle = rotationCycle({ payload: 65 }, [{ op: "*", register: "payload" }]);
    const words = new Map(Object.entries(cycle.registers).map(([k, v]) => [k, fixedWord(v, 10)]));
    let a = "0", iterations = 0;
    do {
      for (const inst of cycle.body) {
        if (inst.op === "p") a = crazy(a, words.get(inst.register)!);
        else if (inst.op === "*") a = rotate(words.get(inst.register)!, width);
        else throw new Error("unexpected I/O in rotation cycle");
        words.set(inst.register, a);
      }
      iterations++;
      expect(["1", "101"]).toContain(a);
      if (iterations > width) throw new Error("marker failed to return");
    } while (a !== "1");
    expect(iterations).toBe(width);
    expect(words.get("payload")).toBe(fixedWord(65, 10));
    expect(words.get("rotation.marker")).toBe(fixedWord(3, 10));
  });

  it("emits the same loop body for different installation widths", () => {
    const cycle = rotationCycle();
    const narrow = planAccumulatorLoop({ width: 10, ...cycle });
    const wide = planAccumulatorLoop({ width: 20, ...cycle });
    expect(narrow.runtime).toEqual(wide.runtime);
    expect(() => rotationCycle({ "rotation.marker": 0 })).toThrow(/reserved/);
  });

  it.each([11, 31, 64])("executes the installed native loop at unknown width %i", (width) => {
    const loop = planAccumulatorLoop({ width: 10, ...rotationCycle({ payload: 65 }, [{ op: "*", register: "payload" }]) });
    // Unit-test the runtime phase in isolation. This fixture deliberately
    // installs the image; it is not evidence of a width-independent installer.
    const m = UnshackledMachine.fromSource(String.fromCharCode(valueForOp("v", 0), fillerValue(1)), "", fixedWidthPolicy(width));
    for (const p of loop.runtime.patches) m.write(fromNumber(p.cell), fixedWord(p.value, 10));
    m.c = fromNumber(loop.entry + 1); m.d = fromNumber(loop.runtime.entryPointer + 1);
    expect(m.run(3_000_000), m.crashReason).toBe("halted");
    expect(m.read(fromNumber(loop.symbols.get("payload")!))).toBe(fixedWord(65, 10));
    expect(m.read(fromNumber(loop.symbols.get("rotation.marker")!))).toBe(fixedWord(3, 10));
  }, 15_000);
});
