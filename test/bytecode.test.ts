import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assembleBytecode, decodeBytecode, disassembleBytecode, encodeBytecode, OPCODE_IDS, runVM } from "../src/vm/index.js";

describe("portable bytecode and canonical assembly", () => {
  it("defines an explicit versioned, little-endian binary layout", () => {
    const bytes = encodeBytecode(assembleBytecode("push -1\nputc\nhalt"));
    expect([...bytes]).toEqual([
      77, 66, 86, 77, 1, 0, 10, 0, 0, 0, 0, 0, 3, 0, 0, 0,
      1, 0xa8, 0xe6, 2, 0, // 59048 = -1 modulo 3^10
    ]);
    expect(decodeBytecode(bytes).instructions[0]).toEqual({ op: "push", value: -1n });
  });

  it.each([10, 20, 1024])("round-trips every opcode, labels and metadata at width %i", (width) => {
    const source = `.width ${width}\n.locals 7\nstart:\npush -123\nload 6\nstore 0\nmodi -3\ndivi 10\nputci 65\n` +
      Object.keys(OPCODE_IDS).filter((op) => !["push", "modi", "divi", "putci", "load", "store", "jump", "jz", "call"].includes(op)).join("\n") +
      "\njump start\njz start\ncall start\nhalt\n";
    const program = assembleBytecode(source), bytes = encodeBytecode(program);
    expect(decodeBytecode(bytes)).toEqual(program);
    expect(encodeBytecode(assembleBytecode(disassembleBytecode(bytes)))).toEqual(bytes);
    const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
    expect(decodeBytecode(padded.subarray(2, -2))).toEqual(program);
  });

  it("preserves FizzBuzz execution through binary and textual round trips", () => {
    const source = readFileSync(new URL("../examples/fizzbuzz.vm", import.meta.url), "utf8");
    const original = assembleBytecode(source), restored = assembleBytecode(disassembleBytecode(encodeBytecode(original)));
    expect(runVM(restored)).toEqual(runVM(original));
  });

  it("normalizes oversized immediates without losing their VM meaning", () => {
    const program = assembleBytecode("push 59050\nputc\nhalt");
    const decoded = decodeBytecode(encodeBytecode(program));
    expect(decoded.instructions[0]).toEqual({ op: "push", value: 1n });
    expect(runVM(decoded)).toEqual(runVM(program));
  });
  it("encodes immediate operations without changing the original opcode IDs", () => {
    expect(OPCODE_IDS).toMatchObject({ halt: 0, push: 1, ret: 20, modi: 21, putci: 22, divi: 23 });
    const program = assembleBytecode("push -17\nmodi 59052\nputci 65\nhalt");
    const bytes = encodeBytecode(program), restored = decodeBytecode(bytes);
    expect(restored.instructions[1]).toEqual({ op: "modi", value: 3n });
    expect(runVM(restored)).toMatchObject({ stack: [-2n], output: "A", status: "halted" });
    for (const op of ["modi", "divi", "putci"]) {
      const encoded = encodeBytecode(assembleBytecode(`${op} 1`));
      expect(() => decodeBytecode(encoded.slice(0, -1))).toThrow(/truncated/);
      for (const source of [op, `${op} nope`, `${op} 1 2`]) expect(() => assembleBytecode(source)).toThrow();
    }
  });

  it("rejects truncated, unsupported, noncanonical and trailing data", () => {
    const valid = encodeBytecode(assembleBytecode("push 1\nhalt"));
    for (let end = 0; end < valid.length; end++) expect(() => decodeBytecode(valid.slice(0, end))).toThrow();
    for (const [at, value] of [[0, 0], [4, 2], [5, 1], [16, 255], [18, 255]]) {
      const bad = valid.slice(); bad[at] = value;
      expect(() => decodeBytecode(bad)).toThrow();
    }
    expect(() => decodeBytecode(new Uint8Array([...valid, 0]))).toThrow(/trailing/);
    const branch = encodeBytecode(assembleBytecode("top: jump top"));
    new DataView(branch.buffer).setUint32(17, 1, true);
    expect(() => decodeBytecode(branch)).toThrow(/jump target/);
    expect(() => encodeBytecode({ width: 10, localCount: 0, instructions: [{ op: "load", index: 0 }] })).toThrow(/local index/);
  });

  it("round-trips empty programs and rejects conflicting directives", () => {
    const empty = assembleBytecode(".width 20\n.locals 3\n");
    expect(assembleBytecode(disassembleBytecode(empty))).toEqual(empty);
    for (const source of [".width 10\n.width 10", ".locals 0\n.locals 0", "halt\n.width 10", ".unknown 1", ".width nope", ".locals -1"]) {
      expect(() => assembleBytecode(source)).toThrow();
    }
    expect(() => assembleBytecode(".width 20", { width: 10 })).toThrow(/conflicts/);
    expect(() => assembleBytecode(".locals 2", { localCount: 3 })).toThrow(/conflicts/);
    expect(() => assembleBytecode(".locals 0\nload 0")).toThrow(/localCount/);
  });
});
