import { describe, expect, it } from "vitest";
import { MicroBuilder } from "../src/vm/micro.js";
import { UnshackledMachine, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, toBigInt, crazy } from "../src/malbolge/trits.js";
import type { BankWord } from "../src/hell/bootstrap.js";

function execute(b: MicroBuilder, input = "") {
  const plan = b.finish(b.label("main"), { none: 0 });
  const basis = 3n ** 60n, resolve = (at: BankWord) => fromBigInt(BigInt(at.bank) * basis + BigInt(at.offset));
  const m = UnshackledMachine.fromSource("QP", input, referencePolicy(19));
  m.write(resolve(b.layout.one), "1");
  for (const p of plan.patches) m.write(resolve(p.at), typeof p.value === "string" ? p.value : resolve(p.value));
  m.c = resolve({ ...plan.entry, offset: plan.entry.offset + 1 }); m.d = resolve({ ...plan.next, offset: plan.next.offset + 1 });
  expect(m.run(20_000_000), m.crashReason).toBe("halted");
  return { m, value: (name: string) => m.read(resolve(b.registers.get(name)!.frame.fields[0])) };
}
describe("shared native microcode primitives", () => {
  it("copies values, branches, and reads/writes indirect fields", () => {
    const b = new MicroBuilder(10), value = b.reg("value"), pointer = b.reg("pointer"), flag = b.reg("flag");
    const data = b.frame(); b.fill(data, ["0", fromBigInt(65n)]);
    b.mark(b.label("main")); b.set(pointer, data.pointer); b.get(value, pointer, 1); b.emit("out", value);
    b.jz(flag, b.label("yes")); b.emit("fault.none"); b.mark(b.label("yes"));
    b.set(value, fromBigInt(66n)); b.put(pointer, 1, value); b.get(value, pointer, 1); b.emit("out", value);
    b.set(flag, fromBigInt(2n)); b.jz(flag, b.label("main")); b.emit("fault.none");
    expect(execute(b).m.outputString()).toBe("AB");
  });
  it.each([10, 20])("rotates logical words and preserves base-one values at width %i", (width) => {
    const b = new MicroBuilder(width), word = b.reg("word"), mask = b.reg("mask"), result = b.reg("result"), copy = b.reg("copy");
    const input = 3n ** BigInt(width - 1) + 5n;
    b.mark(b.label("main")); b.set(word, fromBigInt(input)); b.rol(word);
    b.crazy(mask, b.constant("1"), b.constant("0"));
    b.crazy(result, b.constant("0"), mask); b.mov(copy, result); b.emit("fault.none");
    const run = execute(b);
    expect(toBigInt(run.value("word"))).toBe(16n);
    expect(run.value("result")).toBe(crazy("0", crazy("1", "0")));
    expect(run.value("copy")).toBe(run.value("result"));
  });
  it("dispatches all three trit branches", () => {
    const b = new MicroBuilder(10), flag = b.reg("flag"), value = b.reg("value");
    b.mark(b.label("main"));
    for (let i = 0; i < 3; i++) {
      const next = b.unique("next"), branches = [b.unique("zero"), b.unique("one"), b.unique("two")];
      b.set(flag, fromBigInt(BigInt(i))); b.branch3(flag, branches[0], branches[1], branches[2]);
      branches.forEach((label, digit) => { b.mark(label); b.set(value, fromBigInt(65n + BigInt(digit))); b.emit("out", value); b.jump(next); });
      b.mark(next);
    }
    b.emit("fault.none"); expect(execute(b).m.outputString()).toBe("ABC");
  });
  it.each(["A", "\n", ""])("captures finite input and sentinel classification for %j", (input) => {
    const b = new MicroBuilder(20), value = b.reg("value"), flag = b.reg("flag");
    b.mark(b.label("main")); b.emit("in", value, flag); b.emit("fault.none");
    const run = execute(b, input);
    expect(toBigInt(run.value("flag"))).toBe(input === "A" ? 0n : 2n);
    expect(toBigInt(run.value("value"))).toBe(input === "A" ? 65n : 3n ** 20n - (input ? 2n : 1n));
  });
});
