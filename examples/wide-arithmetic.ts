/** Generate a program that adds two input character codes and prints their sum. */
import { Arithmetic, assembleRegisters } from "../src/hell/index.js";

const width = 20;
const arithmetic = new Arithmetic(width);
const assembled = assembleRegisters({
  width,
  registers: { left: 0, right: 0, result: 0, ...arithmetic.registers },
  instructions: [
    { op: "getc", dest: "left" },
    { op: "getc", dest: "right" },
    ...arithmetic.add("result", "left", "right"),
    { op: "putc", source: "result" },
  ],
});
// Input " !" produces "A". Use fixedWidthPolicy(20) or the Unshackled-20 oracle.
process.stdout.write(assembled.source + "\n");
