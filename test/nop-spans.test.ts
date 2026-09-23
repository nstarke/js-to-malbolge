import { expect, it } from "vitest";
import { UnshackledMachine, referencePolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, fromNumber, fromOffset, modClass, next, type Trits } from "../src/malbolge/trits.js";
import { permanentNopValues, valueForOp } from "../src/hell/cycles.js";
import { advanceAddress } from "../src/malbolge/nop-spans.js";

it("advances canonical addresses exactly across carries and all repeating bases", () => {
  const values = [fromBigInt(3n ** 80n - 1n), ...Array.from({ length: 601 }, (_, i) => fromNumber(i - 300)),
    ...Array.from({ length: 61 }, (_, i) => fromOffset(1, BigInt(i - 30)))];
  for (const value of values) {
    let expected = value;
    for (let count = 0; count <= 512; count++) {
      if ([0, 1, 2, 3, 27, 93, 256, 512].includes(count)) expect(advanceAddress(value, count)).toBe(expected);
      expected = next(expected);
    }
  }
});

function pair(start: Trits, length = 300) {
  const slow = UnshackledMachine.fromSource("QP", "A\n", referencePolicy(19));
  const fast = UnshackledMachine.fromSource("QP", "A\n", referencePolicy(19));
  const addresses: Trits[] = [];
  let at = start;
  for (let i = 0; i < length; i++) {
    addresses.push(at);
    const values = permanentNopValues(modClass(at));
    const value = fromNumber(values[i % values.length]);
    slow.write(at, value); fast.write(at, value); at = next(at);
  }
  addresses.push(at);
  for (const machine of [slow, fast]) {
    machine.write(at, fromNumber(valueForOp("v", modClass(at))));
    machine.c = start; machine.d = fromBigInt(3n ** 60n - 73n);
  }
  const same = () => {
    expect([fast.a, fast.c, fast.d, fast.steps, fast.rotWidth, fast.maxDWidth, fast.outputString(), fast.crashReason])
      .toEqual([slow.a, slow.c, slow.d, slow.steps, slow.rotWidth, slow.maxDWidth, slow.outputString(), slow.crashReason]);
    for (const address of addresses) expect(fast.read(address), address).toBe(slow.read(address));
  };
  return { slow, fast, addresses, same };
}

it.each([fromNumber(2000), fromBigInt(3n ** 80n), fromOffset(1, 1024n), fromNumber(-150)])(
  "batches encryption cycles at %s with exact pause/resume and readable memory", (start) => {
    const { slow, fast, same } = pair(start);
    for (let pass = 0; pass < 15; pass++) {
      slow.c = start; fast.c = start;
      for (const count of [1, 37, 201, 3, 59]) {
        const limit = slow.steps + count;
        expect(fast.run(limit)).toBe(slow.run(limit, false)); same();
      }
      expect(fast.run(fast.steps + 1)).toBe(slow.run(slow.steps + 1, false)); same();
    }
    expect(fast.batchedNopSteps).toBeGreaterThan(0);
  });

it("materializes pending encryption for an explicit code write and scalar stepping", () => {
  const start = fromNumber(5000), { slow, fast, addresses, same } = pair(start, 80);
  slow.run(80, false); fast.run(80); same();
  slow.c = start; fast.c = start;
  const changed = addresses[24], halt = fromNumber(valueForOp("v", modClass(changed)));
  slow.write(changed, halt); fast.write(changed, halt); same();
  expect(fast.run(200)).toBe(slow.run(200, false)); same();
  slow.write(changed, fromNumber(permanentNopValues(modClass(changed))[0]));
  fast.write(changed, slow.read(changed));
  slow.c = start; fast.c = start;
  slow.run(slow.steps + 80, false); fast.run(fast.steps + 80); same();
  slow.c = addresses[7]; fast.c = addresses[7];
  for (let i = 0; i < 10; i++) { expect(fast.step()).toBe(slow.step()); same(); }
});

it("does not batch a current no-op that encrypts into an instruction", () => {
  const { slow, fast, addresses, same } = pair(fromNumber(7000), 90);
  const address = addresses.find((at) => valueForOp("<", modClass(at)) === 70)!;
  slow.write(address, fromNumber(74)); fast.write(address, fromNumber(74));
  for (let i = 0; i < 2; i++) {
    slow.c = addresses[0]; fast.c = addresses[0];
    expect(fast.run(fast.steps + 90)).toBe(slow.run(slow.steps + 90, false)); same();
  }
  expect(fast.outputString()).toBe("\0");
});

it("batches source no-ops with exact encryption and respects sparse source overrides", () => {
  const source = Array.from({ length: 300 }, (_, i) => String.fromCharCode(valueForOp(i === 299 ? "v" : "o", i))).join("");
  for (const replacement of [undefined, "1", fromNumber(valueForOp("v", 83))]) {
    const slow = UnshackledMachine.fromSource(source), fast = UnshackledMachine.fromSource(source);
    if (replacement !== undefined) { slow.write(fromNumber(83), replacement); fast.write(fromNumber(83), replacement); }
    slow.d = fromNumber(-200); fast.d = slow.d;
    for (const limit of [1, 51, 120, 300]) {
      expect(fast.run(limit)).toBe(slow.run(limit, false));
      expect([fast.a, fast.c, fast.d, fast.steps, fast.crashReason]).toEqual([slow.a, slow.c, slow.d, slow.steps, slow.crashReason]);
      for (let i = 0; i < 300; i++) expect(fast.read(fromNumber(i))).toBe(slow.read(fromNumber(i)));
    }
    expect(fast.batchedNopSteps).toBeGreaterThan(0);
  }
});
