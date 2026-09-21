import { describe, expect, it } from "vitest";
import { MalbolgeLoadError, StandardMachine, loadStandard, runStandard } from "../src/malbolge/standard.js";
import { hasFixture, readFixture } from "./helpers.js";

// Andrew Cooke's original program, produced by beam search; prints "Hello, world.".
const HELLO_COOKE =
  "(=<`#9]~6ZY327Uv4-QsqpMn&+Ij\"'E%e{Ab~w=_:]Kw%o44Uqp0/Q?xNvL:`H%c#DD2^WV>gY;dts76qKJImZkj";

describe("standard Malbolge interpreter", () => {
  it("rejects invalid programs", () => {
    expect(() => loadStandard("")).toThrow(MalbolgeLoadError);
    expect(() => loadStandard("ab")).toThrow(MalbolgeLoadError);
    expect(() => loadStandard("(=é")).toThrow(MalbolgeLoadError);
  });

  it("runs the original hello world", () => {
    const r = runStandard(HELLO_COOKE);
    expect(r.status).toBe("halted");
    expect(r.output).toBe("Hello, world.");
  });

  it.skipIf(!hasFixture("hello-world.mu"))("runs malbolge.org hello world", () => {
    const r = runStandard(readFixture("hello-world.mu"));
    expect(r.status).toBe("halted");
    expect(r.output).toBe("Hello, world!\n");
  });

  it.skipIf(!hasFixture("cat-forever.mb"))("runs the non-terminating cat", () => {
    const m = StandardMachine.fromSource(readFixture("cat-forever.mb"), "hello cat\n");
    const status = m.run(20000);
    expect(status).toBe("step-limit");
    expect(m.outputString().startsWith("hello cat\n")).toBe(true);
  });
});
