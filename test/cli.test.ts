import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleBytecode, decodeBytecode, encodeBytecode, runVM } from "../src/vm/index.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const invoke = (args: string[], input?: string | Uint8Array) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { input, timeout: 30_000 });

describe("bytecode tools CLI", () => {
  it("compiles JS to portable bytecode and equivalent assembly", () => {
    const folded = invoke(["compile", "-", "--emit", "bytecode"], "console.log(19+23)");
    const unfolded = invoke(["compile", "-", "--emit", "bytecode", "--no-optimize"], "console.log(19+23)");
    expect(decodeBytecode(folded).instructions.length).toBeLessThan(decodeBytecode(unfolded).instructions.length);
    const source = "for(let i=0;i<3;i++) console.log(i);";
    const bytes = invoke(["compile", "-", "--emit", "bytecode", "--width", "10"], source);
    expect(runVM(decodeBytecode(bytes)).output).toBe("0\n1\n2\n");
    const assembly = invoke(["compile", "-", "--emit", "assembly", "--width", "10"], source);
    expect(invoke(["assemble", "-"], assembly)).toEqual(bytes);
  });
  it("accepts heap capacity for portable aggregate compilation", () => {
    const source = 'const a=[]; a.push(1,2); a.pop(); a.push(3); console.log(a[1],a.length,a[2],a[2]??9);';
    const bytes = invoke(["compile", "-", "--emit", "bytecode", "--heap-capacity", "3"], source);
    expect(runVM(decodeBytecode(bytes)).output).toBe("3 2 undefined 9\n");
    const assembly = invoke(["compile", "-", "--emit", "assembly", "--heap-capacity", "3"], source);
    expect(invoke(["assemble", "-"], assembly)).toEqual(bytes);
  });
  it("reports JS locations, native budgets, and invalid compile options", () => {
    const cases: [string[], string, RegExp][] = [
      [["compile", "-", "--emit", "bytecode"], "let x=unknown;", /<stdin>:1:7:/],
      [["compile", "-", "--max-source-cells", "1000"], "let x=1;console.log(x);", /budget/],
      [["compile", "-", "--emit", "wrong"], "", /--emit requires/],
      [["compile", "-", "--emit", "assembly", "--stack-capacity", "1"], "", /native linker options/],
      [["compile", "-", "--optimize", "wrong"], "", /optimize requires/],
      [["compile", "-", "--installer", "wrong"], "", /installer requires/],
      [["compile", "-", "--stats", "-"], "", /paths must differ/],
      [["compile", "-", "--emit", "bytecode", "--stats", "stats.json"], "", /native linker options/],
      [["compile", "-", "--width", "9"], "", /width/],
      [["compile", "-", "--heap-capacity", "0"], "", /heapCapacity/],
      [["compile", "-", "--heap-capacity", "x"], "", /nonnegative integer/],
      [["compile", "-", "--max-source-cells", "1000"], 'console.log("Hi");', /budget/],
    ];
    for (const [args, input, error] of cases) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { input });
      expect(result.status).toBe(1); expect(result.stderr.toString()).toMatch(error); expect(result.stdout.length).toBe(0);
    }
  });
  it("assembles and disassembles through standard streams", () => {
    const source = ".width 20\n.locals 0\npush 65\nputc\nhalt\n";
    const bytes = invoke(["assemble", "-"], source);
    expect(decodeBytecode(bytes)).toEqual(assembleBytecode(source));
    expect(invoke(["assemble", "-"], invoke(["disassemble", "-"], bytes))).toEqual(bytes);
    expect(invoke(["--help"]).toString()).toContain("js2mb link");
  });
  it("writes explicit output files without overwriting its input", () => {
    const dir = mkdtempSync(join(tmpdir(), "js2mb-cli-"));
    try {
      const input = join(dir, "program.vm"), output = join(dir, "program.mbc");
      writeFileSync(input, "halt\n");
      invoke(["assemble", input, "-o", output]);
      expect(readFileSync(output)).toEqual(Buffer.from(encodeBytecode(assembleBytecode("halt"))));
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, "assemble", input, "-o", input]);
      expect(result.status).toBe(1); expect(result.stderr.toString()).toContain("paths must differ");
      expect(readFileSync(input, "utf8")).toBe("halt\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("assembles relative includes and restores symbols in annotated and JSON listings", () => {
    const dir = mkdtempSync(join(tmpdir(), "js2mb-assembly-"));
    try {
      const input = join(dir, "main.vm"), output = join(dir, "program.mbc"), map = join(dir, "program.map.json");
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib", "constants.vm"), ".equ LETTER, 'Q'\n");
      writeFileSync(join(dir, "lib", "body.vm"), '.include "constants.vm"\nentry: putci LETTER\n.println "🙂"\nhalt\n');
      writeFileSync(input, '.width 20\n.local scratch\n.include "lib/body.vm"\n');
      invoke(["assemble", input, "-o", output, "--map", map, "--width", "20", "--locals", "2"]);
      const binary = readFileSync(output), symbols = JSON.parse(readFileSync(map, "utf8"));
      expect(runVM(decodeBytecode(binary)).output).toBe("Q🙂\n");
      expect(symbols).toMatchObject({ format: "MBVM-map", version: 1 });
      expect(symbols.sourceMap[0]).toMatchObject({ pc: 0, location: { filename: join(dir, "lib", "body.vm"), line: 2, column: 8 } });
      expect(symbols.symbols).toContainEqual(expect.objectContaining({ name: "LETTER", kind: "constant", value: "81" }));
      const listing = invoke(["disassemble", output, "--symbols", map, "--radix", "hex", "--annotate"]).toString();
      expect(listing).toContain("entry:"); expect(listing).toContain("putci 0x51 # pc=0 offset=0x10");
      expect(invoke(["assemble", "-"], listing)).toEqual(binary);
      const inspection = JSON.parse(invoke(["disassemble", output, "--symbols", map, "--format", "json"]).toString());
      expect(inspection).toMatchObject({ format: "MBVM", width: 20, localCount: 2, byteLength: binary.length });
      expect(inspection.instructions[0]).toMatchObject({ pc: 0, offset: 16, label: "entry", operand: "81" });
      const changed = Buffer.from(binary); changed[17]++;
      const mismatch = spawnSync(process.execPath, ["--import", "tsx", cli, "disassemble", "-", "--symbols", map], { input: changed, timeout: 30_000 });
      expect(mismatch.status).toBe(1); expect(mismatch.stderr.toString()).toMatch(/hash mismatch/);
      for (const path of [input, output, "-"]) {
        const collision = spawnSync(process.execPath, ["--import", "tsx", cli, "assemble", input, "-o", output, "--map", path], { timeout: 30_000 });
        expect(collision.status).toBe(1); expect(collision.stderr.toString()).toMatch(/paths must differ/);
      }
      expect(readFileSync(output)).toEqual(binary);
      for (const option of ["-o", "--map"]) {
        const collision = spawnSync(process.execPath, ["--import", "tsx", cli, "assemble", input, option, join(dir, "lib", "constants.vm")], { timeout: 30_000 });
        expect(collision.status).toBe(1); expect(collision.stderr.toString()).toMatch(/included source/);
      }
      expect(readFileSync(join(dir, "lib", "constants.vm"), "utf8")).toBe(".equ LETTER, 'Q'\n");
      writeFileSync(join(dir, "lib", "constants.vm"), ".equ LETTER, missing\n");
      const invalid = spawnSync(process.execPath, ["--import", "tsx", cli, "assemble", input], { timeout: 30_000 });
      expect(invalid.status).toBe(1); expect(invalid.stderr.toString()).toContain("constants.vm:1:");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects incompatible listing options and conflicting assembly metadata", () => {
    const cases: [string[], RegExp][] = [
      [["disassemble", "-", "--radix", "binary"], /--radix requires/],
      [["disassemble", "-", "--format", "xml"], /--format requires/],
      [["disassemble", "-", "--format", "json", "--annotate"], /require assembly output/],
      [["assemble", "-", "--width", "20"], /conflicts/],
    ];
    for (const [args, message] of cases) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { input: ".width 10\nhalt", timeout: 30_000 });
      expect(result.status).toBe(1); expect(result.stderr.toString()).toMatch(message);
    }
  });
  it("reports invalid input and source budgets as failures", () => {
    const cases: [string[], string | Uint8Array, RegExp][] = [
      [["disassemble", "-"], "not bytecode", /header/],
      [["link", "-", "--max-source-cells", "1000"], encodeBytecode(assembleBytecode("push 1\npush 2\nadd\nhalt")), /budget/],
      [["link", "-", "--max-source-cells", "1000"], encodeBytecode(assembleBytecode("halt")), /budget/],
      [["link", "-", "--stack-capacity", "1.5"], "", /integer/],
    ];
    for (const [args, input, message] of cases) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { input });
      expect(result.status).toBe(1); expect(result.stderr.toString()).toMatch(message);
      expect(result.stdout.length).toBe(0);
    }
  });
});
