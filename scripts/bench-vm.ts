/** Reproducible native benchmark. Source mode performs the complete bootstrap. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setImmediate } from "node:timers/promises";
import { compileJS } from "../src/frontend/index.js";
import { assembleHeLLVM, planHeLLVM, encodeBytecode, runVM, type HeLLVMOptions } from "../src/vm/index.js";
import { UnshackledMachine, minimalPolicy } from "../src/malbolge/unshackled.js";
import { fromBigInt, fromNumber, toBigInt } from "../src/malbolge/trits.js";
import type { BankWord } from "../src/hell/bootstrap.js";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    mode: { type: "string", default: "source" }, width: { type: "string", default: "10" },
    "max-steps": { type: "string", default: "100000000000" }, seconds: { type: "string", default: "3600" },
    "stack-capacity": { type: "string", default: "16" }, "return-stack-capacity": { type: "string", default: "16" },
    report: { type: "string" }, optimize: { type: "string", default: "speed" }, installer: { type: "string", default: "unrolled" },
  } });
  if (positionals.length > 1) throw new Error("expected at most one JavaScript input file");
  if (!["source", "runtime"].includes(values.mode)) throw new Error("--mode must be source or runtime");
  const number = (name: "width" | "max-steps" | "seconds" | "stack-capacity" | "return-stack-capacity") => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive safe integer`);
    return value;
  };
  const input = resolve(positionals[0] ?? "examples/fizzbuzz.js");
  if (values.report && resolve(values.report) === input) throw new Error("report and input paths must differ");
  const width = number("width"), maxSteps = number("max-steps"), seconds = number("seconds");
  if (values.optimize !== "speed" && values.optimize !== "size") throw new Error("--optimize must be speed or size");
  if (values.installer !== "unrolled" && values.installer !== "loop") throw new Error("--installer must be unrolled or loop");
  const options: HeLLVMOptions = { optimize: values.optimize, installer: values.installer, stackCapacity: number("stack-capacity"), returnStackCapacity: number("return-stack-capacity") };
  const program = compileJS(readFileSync(input, "utf8"), { width, filename: input }), expected = runVM(program);
  if (expected.status !== "halted") throw new Error("reference VM did not halt within its instruction limit");
  const started = performance.now();
  const image = values.mode === "source" ? assembleHeLLVM(program, options) : undefined;
  const plan = image?.vm ?? planHeLLVM(program, options);
  const compileMs = performance.now() - started;
  let basis = 3n ** 60n;
  const address = (at: BankWord) => fromBigInt(BigInt(at.bank) * basis + BigInt(at.offset));
  const m = UnshackledMachine.fromSource(image?.source ?? "QP", "", minimalPolicy());
  if (!image) {
    // Deliberately separate from full-source verification: bypass installation.
    m.write(address(plan.kind === "microcode" ? plan.microcode.layout.one : plan.symbols.get("$bank.one")!), "1");
    for (const patch of plan.patches) m.write(address(patch.at), typeof patch.value === "string" ? patch.value : address(patch.value));
    m.c = address({ ...plan.entry, offset: plan.entry.offset + 1 }); m.d = address({ ...plan.next, offset: plan.next.offset + 1 });
  }
  const loadMs = performance.now() - started - compileMs, runStart = performance.now();
  let status: ReturnType<typeof m.run> = "step-limit", lastProgress = runStart;
  process.stderr.write(JSON.stringify({ mode: values.mode, sourceCells: image?.source.length, codeCells: plan.codeCells, compileMs, loadMs }) + "\n");
  while (status === "step-limit" && m.steps < maxSteps && performance.now() - runStart < seconds * 1000) {
    status = m.run(Math.min(maxSteps, m.steps + 1_000_000));
    await setImmediate();
    if (performance.now() - lastProgress >= 10_000) {
      lastProgress = performance.now();
      process.stderr.write(JSON.stringify({ seconds: (lastProgress - runStart) / 1000, steps: m.steps, outputBytes: Buffer.byteLength(m.outputString()) }) + "\n");
    }
  }
  const output = m.outputString();
  if (image && status === "halted") basis = toBigInt(m.read(fromNumber(image.basisRegister)))! / 2n;
  const fault = status === "halted" ? [...plan.faults].find(([, at]) => m.c === address({ ...at, offset: at.offset + 1 }))?.[0] : undefined;
  const complete = status === "halted" && fault === 0 && output === expected.output;
  const report = {
    input, mode: values.mode, width, ...options, sourceCells: image?.source.length, installation: image?.statistics, bytecodeBytes: encodeBytecode(program).length,
    bytecodeInstructions: program.instructions.length, codeCells: plan.codeCells, compileMs, loadMs, executionMs: performance.now() - runStart,
    status, fault, complete, steps: m.steps, batchedNopSteps: m.batchedNopSteps, outputBytes: Buffer.byteLength(output),
    expectedOutputBytes: Buffer.byteLength(expected.output), output, crashReason: m.crashReason, rotationWidth: m.rotWidth,
    rssBytes: process.memoryUsage().rss,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.report) writeFileSync(values.report, json);
  process.stdout.write(json);
  process.exitCode = complete ? 0 : status === "step-limit" ? 2 : 1;
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
