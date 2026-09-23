/** Source-size measurements; does not execute the generated Malbolge. */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { parseArgs } from "node:util";
import { compileJS } from "../src/frontend/index.js";
import { assembleHeLLVM, encodeBytecode, type HeLLVMOptions } from "../src/vm/index.js";

const { values } = parseArgs({ options: { report: { type: "string" } } });
const fizz = readFileSync(new URL("../examples/fizzbuzz.js", import.meta.url), "utf8");
const samples: { name: string; source: string; width: number; options: HeLLVMOptions }[] = [
  { name: "literal", source: 'console.log("AB")', width: 20, options: { stackCapacity: 1 } },
  { name: "constant", source: "console.log(19+23)", width: 20, options: { optimize: "size" } },
  ...(["speed", "size"] as const).flatMap((optimize) => (["unrolled", "loop"] as const).map((installer) => ({
    name: `fizzbuzz-${optimize}-${installer}`, source: fizz, width: 10, options: { optimize, installer },
  }))),
];
const measurements = samples.map(({ name, source, width, options }) => {
  const program = compileJS(source, { width }), start = performance.now();
  const image = assembleHeLLVM(program, options);
  const result = { name, width, optimize: options.optimize ?? "speed", ...image.statistics,
    bytecodeInstructions: program.instructions.length, bytecodeBytes: encodeBytecode(program).length,
    codeCells: image.codeCells, stackCapacity: image.vm.stackCapacity, compileMs: performance.now() - start };
  process.stderr.write(JSON.stringify(result) + "\n");
  return result;
});
const report = JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  cpu: cpus()[0]?.model, measurements }, null, 2) + "\n";
if (values.report) writeFileSync(values.report, report);
process.stdout.write(report);
