import { Arithmetic, assembleRegisterLoop } from "../src/hell/index.js";

const width = 20, arithmetic = new Arithmetic(width);
const program = assembleRegisterLoop({
  width, registers: { ...arithmetic.registers, pointer: 0, value: 64, again: 0 }, arrays: { data: [0] },
  body: [
    { op: "array-base", dest: "pointer", array: "data" }, ...arithmetic.increment("value"),
    { op: "store", pointer: "pointer", source: "value" }, { op: "set", dest: "value", value: 0 },
    { op: "load", pointer: "pointer", dest: "value" }, { op: "putc", source: "value" }, { op: "getc", dest: "again" },
  ], while: "again",
}, { maxSourceCells: 300_000_000 });
process.stdout.write(program.source);
