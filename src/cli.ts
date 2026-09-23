#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { assembleBytecodeDetailed, inspectBytecode, assembleHeLLVM, disassembleBytecode, encodeBytecode, type HeLLVMOptions, type AssemblyOptions, type DisassembleOptions } from "./vm/index.js";
import { compileJS } from "./frontend/index.js";

const usage = `Usage:
  js2mb compile <input.js|-> [-o output] [--emit malbolge|bytecode|assembly] [--width N]
  js2mb assemble <input.vm|-> [-o output.mbc] [--width N] [--locals N] [--map output.json]
  js2mb disassemble <input.mbc|-> [-o output.vm] [--radix decimal|hex|ternary] [--annotate]
    [--format assembly|json] [--symbols map.json]
  js2mb link <input.mbc|-> [-o output.mb] [--stack-capacity N] [--return-stack-capacity N] [--max-source-cells N]

Use - for standard input or output. Output defaults to standard output.
Assembly supports headers, labels, .equ, .local, .include, .print/.println, and .assert.
Includes resolve relative to their containing file (stdin uses the current directory).
Compile defaults to Malbolge output and logical width 20.
Compile also accepts the native stack capacities and source budget options.
Native options: --optimize speed|size, --installer unrolled|loop, --stats report.json.
Loop installation reduces large images but increases startup work.
Use --no-optimize with compile to disable frontend simplification.
All 24 bytecode opcodes have native handlers. Native images remain large.
`;

try {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || command === "--help" || command === "-h") process.stdout.write(usage);
  else {
    if (!["compile", "assemble", "disassemble", "link"].includes(command)) throw new Error(`unknown command ${command}; use --help`);
    const input = args.shift();
    if (!input) throw new Error(`${command} requires an input file or -`);
    let output: string | undefined;
    const options: HeLLVMOptions = {};
    let format = "malbolge", width = 20, optimize = true;
    let stats: string | undefined, mapOutput: string | undefined, symbolsInput: string | undefined;
    let disassemblyFormat = "assembly";
    const assemblyOptions: AssemblyOptions = {};
    const disassemblyOptions: DisassembleOptions = {};
    const seen = new Set<string>();
    while (args.length) {
      const option = args.shift()!;
      if (seen.has(option)) throw new Error(`duplicate option ${option}`);
      seen.add(option);
      if (option === "-o") {
        output = args.shift(); if (!output) throw new Error("-o requires an output file");
      } else if (command === "assemble" && option === "--map") {
        mapOutput = args.shift(); if (!mapOutput || mapOutput.startsWith("--")) throw new Error("--map requires an output file");
      } else if (command === "assemble" && (option === "--width" || option === "--locals")) {
        const text = args.shift(), value = Number(text);
        if (!text || !/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw new Error(`${option} requires a nonnegative integer`);
        if (option === "--width") assemblyOptions.width = value; else assemblyOptions.localCount = value;
      } else if (command === "disassemble" && option === "--annotate") {
        disassemblyOptions.annotate = true;
      } else if (command === "disassemble" && option === "--radix") {
        const value = args.shift();
        if (value !== "decimal" && value !== "hex" && value !== "ternary") throw new Error("--radix requires decimal, hex, or ternary");
        disassemblyOptions.radix = value;
      } else if (command === "disassemble" && option === "--format") {
        const value = args.shift();
        if (value !== "assembly" && value !== "json") throw new Error("--format requires assembly or json");
        disassemblyFormat = value;
      } else if (command === "disassemble" && option === "--symbols") {
        symbolsInput = args.shift(); if (!symbolsInput) throw new Error("--symbols requires a map file");
      } else if (command === "compile" && option === "--no-optimize") {
        optimize = false;
      } else if ((command === "link" || command === "compile") && option === "--stats") {
        stats = args.shift(); if (!stats || stats.startsWith("--")) throw new Error("--stats requires a JSON output path");
      } else if ((command === "link" || command === "compile") && (option === "--optimize" || option === "--installer")) {
        const value = args.shift();
        if (option === "--optimize") {
          if (value !== "speed" && value !== "size") throw new Error("--optimize requires speed or size");
          options.optimize = value;
        } else {
          if (value !== "unrolled" && value !== "loop") throw new Error("--installer requires unrolled or loop");
          options.installer = value;
        }
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
    if (command === "compile" && format !== "malbolge" && (Object.keys(options).length || stats)) throw new Error("native linker options require --emit malbolge");
    if (input !== "-" && output && output !== "-" && resolve(input) === resolve(output)) throw new Error("input and output paths must differ");
    if (stats && (stats === "-" || input !== "-" && resolve(stats) === resolve(input) || output && output !== "-" && resolve(stats) === resolve(output))) throw new Error("stats, input, and output paths must differ; stats requires a file");
    if (mapOutput && (mapOutput === "-" || input !== "-" && resolve(mapOutput) === resolve(input) || output && output !== "-" && resolve(mapOutput) === resolve(output))) throw new Error("map, input, and output paths must differ; map requires a file");
    if (symbolsInput && output && output !== "-" && resolve(symbolsInput) === resolve(output)) throw new Error("symbols and output paths must differ");
    if (disassemblyFormat === "json" && (disassemblyOptions.radix || disassemblyOptions.annotate)) throw new Error("--radix and --annotate require assembly output");
    const link = (program: Parameters<typeof assembleHeLLVM>[0]) => {
      const image = assembleHeLLVM(program, options);
      if (stats) writeFileSync(stats, JSON.stringify({ ...image.statistics, codeCells: image.codeCells, bytecodeInstructions: image.vm.program.instructions.length }, null, 2) + "\n");
      return image.source;
    };
    const data = readFileSync(input === "-" ? 0 : input);
    let result: Uint8Array | string;
    if (command === "compile") {
      const program = compileJS(data.toString("utf8"), { width, optimize, filename: input === "-" ? "<stdin>" : input });
      if (format === "bytecode") result = encodeBytecode(program);
      else if (format === "assembly") result = disassembleBytecode(program);
      else result = link(program);
    } else if (command === "assemble") {
      const includedFiles = new Set<string>();
      const assembled = assembleBytecodeDetailed(data.toString("utf8"), { ...assemblyOptions,
        filename: input === "-" ? "<stdin>" : resolve(input),
        resolveInclude: (specifier, from) => {
          const filename = resolve(from === "<stdin>" ? process.cwd() : dirname(from), specifier);
          includedFiles.add(filename);
          return { filename, source: readFileSync(filename, "utf8") };
        },
      });
      for (const destination of [output, mapOutput]) {
        if (destination && destination !== "-" && includedFiles.has(resolve(destination))) throw new Error("output paths must differ from included source files");
      }
      result = encodeBytecode(assembled.program);
      if (mapOutput) writeFileSync(mapOutput, JSON.stringify({ format: "MBVM-map", version: 1,
        sha256: createHash("sha256").update(result).digest("hex"),
        symbols: [...assembled.symbols].map(([name, symbol]) => ({ name, ...symbol, value: symbol.value.toString() })), sourceMap: assembled.sourceMap,
      }, null, 2) + "\n");
    } else if (command === "disassemble") {
      if (symbolsInput) {
        const map = JSON.parse(readFileSync(symbolsInput, "utf8"));
        if (!map || map.format !== "MBVM-map" || map.version !== 1 || !Array.isArray(map.symbols) || map.sha256 !== createHash("sha256").update(data).digest("hex")) throw new Error("invalid symbol map or bytecode hash mismatch");
        const labels = new Map<number, string>();
        for (const symbol of map.symbols) {
          if (!symbol || typeof symbol !== "object") throw new Error("invalid symbol map entry");
          if (symbol.kind !== "label") continue;
          if (typeof symbol.name !== "string" || typeof symbol.value !== "string" || !/^\d+$/.test(symbol.value)) throw new Error("invalid symbol map label");
          const pc = Number(symbol.value);
          if (!labels.has(pc)) labels.set(pc, symbol.name);
        }
        disassemblyOptions.labels = labels;
      }
      result = disassemblyFormat === "json" ? JSON.stringify(inspectBytecode(data, disassemblyOptions), null, 2) + "\n" : disassembleBytecode(data, disassemblyOptions);
    } else result = link(data);
    if (!output || output === "-") process.stdout.write(result);
    else writeFileSync(output, result);
  }
} catch (error) {
  process.stderr.write(`js2mb: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
