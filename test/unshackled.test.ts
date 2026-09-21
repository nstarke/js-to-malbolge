import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { crazy10, isValidSourceInstruction } from "../src/malbolge/tables.js";
import { fromNumber, tritAt, type Trits } from "../src/malbolge/trits.js";

/** Low ten trits of a value as a number (what standard Malbolge would hold). */
function low10(v: Trits): number {
  let n = 0;
  for (let i = 9; i >= 0; i--) n = n * 3 + tritAt(v, i);
  return n;
}
import { UnshackledMachine, fixedWidthPolicy, loadUnshackled, minimalPolicy, referencePolicy, runUnshackled } from "../src/malbolge/unshackled.js";
import { fixturePath, hasFixture, hasOracle, readFixture, runOracle } from "./helpers.js";

const HELLO_COOKE =
  "(=<`#9]~6ZY327Uv4-QsqpMn&+Ij\"'E%e{Ab~w=_:]Kw%o44Uqp0/Q?xNvL:`H%c#DD2^WV>gY;dts76qKJImZkj";

describe("Malbolge Unshackled interpreter", () => {
  it("initial memory fill agrees with standard Malbolge for all 2-char tails", () => {
    // For every pair of last two chars, the six 'rest' values must reproduce the
    // standard crazy fill for cells 2..2000 (this checks the 6-periodicity too).
    for (let x = 33; x <= 126; x++) {
      for (let y = 33; y <= 126; y++) {
        if (!isValidSourceInstruction(x, 0) || !isValidSourceInstruction(y, 1)) continue;
        const p = loadUnshackled(String.fromCharCode(x, y));
        const mem = [x, y];
        for (let i = 2; i < 40; i++) mem[i] = crazy10(mem[i - 1], mem[i - 2]);
        for (let i = 2; i < 40; i++) expect(low10(p.rest[i % 6])).toBe(mem[i]);
      }
    }
    // Direct check on a concrete program, comparing to the standard fill.
    const src = HELLO_COOKE;
    const p = loadUnshackled(src);
    const n = p.cells.length;
    const mem: number[] = Array.from(p.cells);
    for (let i = n; i < 3000; i++) mem[i] = crazy10(mem[i - 1], mem[i - 2]);
    const m = new UnshackledMachine(p);
    for (let i = n; i < 3000; i++) {
      expect(low10(m.read(fromNumber(i)))).toBe(mem[i]);
    }
  });

  it("crashes on the original hello world, which relies on A % 256 output", () => {
    const r = runUnshackled(HELLO_COOKE, { policy: minimalPolicy() });
    expect(r.status).toBe("crash");
    expect(r.crashReason).toMatch(/output/);
  });

  it.skipIf(!hasFixture("hello-world.mu"))("runs malbolge.org hello world under several policies", () => {
    const src = readFixture("hello-world.mu");
    for (const policy of [minimalPolicy(), fixedWidthPolicy(20), referencePolicy(7), referencePolicy(8)]) {
      const r = runUnshackled(src, { policy });
      expect(r.status, r.crashReason).toBe("halted");
      expect(r.output).toBe("Hello, world!\n");
    }
  });

  it.skipIf(!hasFixture("cat.mu"))("runs the terminating cat", () => {
    const src = readFixture("cat.mu");
    const input = "Hello Unshackled\nsecond line\n";
    for (const policy of [minimalPolicy(), referencePolicy(11)]) {
      const r = runUnshackled(src, { input, policy });
      expect(r.status, r.crashReason).toBe("halted");
      expect(r.output).toBe(input);
    }
  });

  it.skipIf(!hasOracle || !hasFixture("cat.mu"))("matches the C reference interpreter on cat", () => {
    const input = "oracle check\nwith two lines\n";
    const expected = runOracle(fixturePath("cat.mu"), input);
    const r = runUnshackled(readFixture("cat.mu"), { input, policy: referencePolicy(99) });
    expect(r.output).toBe(expected);
  });

  it.skipIf(!hasOracle)("C reference interpreter also rejects the original hello world", () => {
    const file = path.join(os.tmpdir(), "js2mb-hello-cooke.mb");
    writeFileSync(file, HELLO_COOKE);
    expect(() => runOracle(file)).toThrow(/invalid unicode codepoint/);
  });
});
