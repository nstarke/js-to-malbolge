import { assembleBootstrappedLoop } from "../src/hell/index.js";

// Input "\x01\0" prints "AA" and halts. Installation consumes no input.
// Run with a conforming, growing-width Unshackled interpreter.
process.stdout.write(assembleBootstrappedLoop({
  width: 10,
  registers: { value: 65, again: 0 },
  body: [
    { op: "putc", source: "value" },
    { op: "getc", dest: "again" },
  ],
  while: "again",
}).source);
