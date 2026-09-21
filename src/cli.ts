#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assembleBytecode, assembleHeLLVM, disassembleBytecode, encodeBytecode } from "./vm/index.js";

const usage = `Usage:
  js2mb assemble <input.vm|-> [-o output.mbc]
  js2mb disassemble <input.mbc|-> [-o output.vm]
  js2mb link <input.mbc|-> [-o output.mb] [--stack-capacity N] [--max-source-cells N]

Use - for standard input or output. Output defaults to standard output.
Assembly supports .width and .locals header directives.
The initial native interpreter supports push, putc, and halt.
`;

try {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || command === "--help" || command === "-h") process.stdout.write(usage);
  else {
    if (!["assemble", "disassemble", "link"].includes(command)) throw new Error(`unknown command ${command}; use --help`);
    const input = args.shift();
    if (!input) throw new Error(`${command} requires an input file or -`);
    let output: string | undefined;
    const options: { stackCapacity?: number; maxSourceCells?: number } = {};
    const seen = new Set<string>();
    while (args.length) {
      const option = args.shift()!;
      if (seen.has(option)) throw new Error(`duplicate option ${option}`);
      seen.add(option);
      if (option === "-o") {
        output = args.shift(); if (!output) throw new Error("-o requires an output file");
      } else if (command === "link" && ["--stack-capacity", "--max-source-cells"].includes(option)) {
        const text = args.shift(), value = Number(text);
        if (text === undefined || !/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw new Error(`${option} requires a nonnegative integer`);
        if (option === "--stack-capacity") options.stackCapacity = value;
        else options.maxSourceCells = value;
      } else throw new Error(`unknown option ${option}`);
    }
    if (input !== "-" && output && output !== "-" && resolve(input) === resolve(output)) throw new Error("input and output paths must differ");
    const data = readFileSync(input === "-" ? 0 : input);
    const result = command === "assemble" ? encodeBytecode(assembleBytecode(data.toString("utf8"))) :
      command === "disassemble" ? disassembleBytecode(data) : assembleHeLLVM(data, options).source;
    if (!output || output === "-") process.stdout.write(result);
    else writeFileSync(output, result);
  }
} catch (error) {
  process.stderr.write(`js2mb: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
