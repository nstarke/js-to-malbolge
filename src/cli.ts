#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assembleBytecode, assembleHeLLVM, disassembleBytecode, encodeBytecode } from "./vm/index.js";
import { compileJS } from "./frontend/index.js";

const usage = `Usage:
  js2mb compile <input.js|-> [-o output] [--emit malbolge|bytecode|assembly] [--width N]
  js2mb assemble <input.vm|-> [-o output.mbc]
  js2mb disassemble <input.mbc|-> [-o output.vm]
  js2mb link <input.mbc|-> [-o output.mb] [--stack-capacity N] [--return-stack-capacity N] [--max-source-cells N]

Use - for standard input or output. Output defaults to standard output.
Assembly supports .width and .locals header directives.
Compile defaults to Malbolge output and logical width 20.
Compile also accepts the native stack capacities and source budget options.
All 21 bytecode opcodes have native handlers. Native images remain large.
`;

try {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || command === "--help" || command === "-h") process.stdout.write(usage);
  else {
    if (!["compile", "assemble", "disassemble", "link"].includes(command)) throw new Error(`unknown command ${command}; use --help`);
    const input = args.shift();
    if (!input) throw new Error(`${command} requires an input file or -`);
    let output: string | undefined;
    const options: { stackCapacity?: number; returnStackCapacity?: number; maxSourceCells?: number } = {};
    let format = "malbolge", width = 20;
    const seen = new Set<string>();
    while (args.length) {
      const option = args.shift()!;
      if (seen.has(option)) throw new Error(`duplicate option ${option}`);
      seen.add(option);
      if (option === "-o") {
        output = args.shift(); if (!output) throw new Error("-o requires an output file");
      } else if (command === "compile" && option === "--emit") {
        const value = args.shift();
        if (!value || !["malbolge", "bytecode", "assembly"].includes(value)) throw new Error("--emit requires malbolge, bytecode, or assembly");
        format = value;
      } else if ((command === "link" || command === "compile") &&
        (["--stack-capacity", "--return-stack-capacity", "--max-source-cells"].includes(option) || command === "compile" && option === "--width")) {
        const text = args.shift(), value = Number(text);
        if (text === undefined || !/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw new Error(`${option} requires a nonnegative integer`);
        if (option === "--stack-capacity") options.stackCapacity = value;
        else if (option === "--return-stack-capacity") options.returnStackCapacity = value;
        else if (option === "--width") width = value;
        else options.maxSourceCells = value;
      } else throw new Error(`unknown option ${option}`);
    }
    if (command === "compile" && format !== "malbolge" && Object.keys(options).length) throw new Error("native linker options require --emit malbolge");
    if (input !== "-" && output && output !== "-" && resolve(input) === resolve(output)) throw new Error("input and output paths must differ");
    const data = readFileSync(input === "-" ? 0 : input);
    let result: Uint8Array | string;
    if (command === "compile") {
      const program = compileJS(data.toString("utf8"), { width, filename: input === "-" ? "<stdin>" : input });
      if (format === "bytecode") result = encodeBytecode(program);
      else if (format === "assembly") result = disassembleBytecode(program);
      else result = assembleHeLLVM(program, options).source;
    } else result = command === "assemble" ? encodeBytecode(assembleBytecode(data.toString("utf8"))) :
      command === "disassemble" ? disassembleBytecode(data) : assembleHeLLVM(data, options).source;
    if (!output || output === "-") process.stdout.write(result);
    else writeFileSync(output, result);
  }
} catch (error) {
  process.stderr.write(`js2mb: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
