import { expect, it } from "vitest";
import { compileJS } from "../src/frontend/index.js";
import { assembleHeLLVM } from "../src/vm/index.js";
import { setImmediate } from "node:timers/promises";
import { UnshackledMachine, minimalPolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, fromNumber, toBigInt } from "../src/malbolge/trits.js";
import type { BankWord } from "../src/hell/bootstrap.js";

it("compiles JS arithmetic to standalone Malbolge without memory injection", async () => {
  const image = assembleHeLLVM(compileJS("const result = 19 + 23;", { width: 10 }), { stackCapacity: 2 });
  if (image.vm.kind !== "microcode") throw new Error("expected the complete interpreter");
  // The reference C loader allocates hundreds of bytes per source cell. Use
  // the byte-backed TS machine for this large complete installation; the
  // smaller compiled-JS output image also runs in the external C oracle.
  const m = UnshackledMachine.fromSource(image.source, "", minimalPolicy());
  let status: ReturnType<typeof m.run> = "step-limit";
  while (status === "step-limit" && m.steps < 600_000_000) { status = m.run(m.steps + 500_000); await setImmediate(); }
  expect(status, `${m.crashReason}; steps=${m.steps}`).toBe("halted");
  const basis = toBigInt(m.read(fromNumber(image.basisRegister)))! / 2n;
  const resolve = (p: BankWord) => fromBigInt(BigInt(p.bank) * basis + BigInt(p.offset));
  const halt = image.vm.faults.get(0)!;
  expect(m.c).toBe(resolve({ ...halt, offset: halt.offset + 1 }));
  expect(toBigInt(m.read(resolve(image.vm.locals[0].fields[0])))).toBe(42n);
  expect(m.read(resolve(image.vm.symbols.get("sp")!))).toBe(resolve(image.vm.stack[0].pointer));
}, 660_000);
