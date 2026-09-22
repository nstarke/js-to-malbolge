import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleBytecode, decodeBytecode, encodeBytecode, runVM } from "../src/vm/index.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const invoke = (args: string[], input?: string | Uint8Array) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { input });

describe("bytecode tools CLI", () => {
  it("compiles JS to portable bytecode and equivalent assembly", () => {
    const source = "for(let i=0;i<3;i++) console.log(i);";
    const bytes = invoke(["compile", "-", "--emit", "bytecode", "--width", "10"], source);
    expect(runVM(decodeBytecode(bytes)).output).toBe("0\n1\n2\n");
    const assembly = invoke(["compile", "-", "--emit", "assembly", "--width", "10"], source);
    expect(invoke(["assemble", "-"], assembly)).toEqual(bytes);
  });
  it("reports JS locations, native budgets, and invalid compile options", () => {
    const cases: [string[], string, RegExp][] = [
      [["compile", "-", "--emit", "bytecode"], "let x=unknown;", /<stdin>:1:7:/],
      [["compile", "-", "--max-source-cells", "1000"], "let x=1;console.log(x);", /budget/],
      [["compile", "-", "--emit", "wrong"], "", /--emit requires/],
      [["compile", "-", "--emit", "assembly", "--stack-capacity", "1"], "", /native linker options/],
      [["compile", "-", "--width", "9"], "", /width/],
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
