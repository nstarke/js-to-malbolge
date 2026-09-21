# Indexed memory, reusable control, and rotation cycles

`assembleRegisters` supports indexed load/store. A separate accumulator-loop
planner supplies executable code that restores itself between iterations.
Live values can pass from the register backend into that loop. Arithmetic
macros still expand into straight-line code; there is no general register-IR
loop compiler or HeLL bytecode interpreter yet.

## Indexed memory

```ts
const arithmetic = new Arithmetic(20);
const program = assembleRegisters({
  width: 20,
  registers: { ...arithmetic.registers, index: 0, pointer: 0, value: 82, result: 0 },
  arrays: { data: [65, 66, 67] },
  instructions: [
    { op: "getc", dest: "index" }, // raw numeric index 0, 1, or 2
    ...arithmetic.address("pointer", "data", "index"),
    { op: "load", dest: "result", pointer: "pointer" },
    { op: "store", pointer: "pointer", source: "value" },
    { op: "putc", source: "result" },
  ],
});
```

Each array element occupies three cells: value, self pointer, and return
pointer. Frames start at address 128 and reclaim initialization instructions
only after those instructions have executed. The initializer writes the return
pointer first, then the self pointer and value. Array metadata appears in
`program.arrays`: `{ base, length, stride: 3 }`.

`array-base` puts `base - 1` into a register. `Arithmetic.address` computes
`base - 1 + 3 * index`, preserving the index unless it aliases the destination.
Pointers refer to initialized frames. Indices must be in bounds; there is no
runtime bounds check yet. Memory operations accept width-bounded finite words
and base-1 masks, not EOF's base-2 sentinel. Load can overwrite its pointer
register; store can use the same register for its pointer and source. Neither
operation changes the frame's steering cells.

Tests select each of three elements using runtime input, preserve adjacent
frames, overwrite wide values repeatedly, and exercise aliases at widths 10
and 20. Width-20 output also matches the C interpreter.

## Reusable accumulator loops

`planAccumulatorLoop({ width, registers, body })` produces an installable
runtime image. Its body uses native accumulator semantics:

- `*` rotates the named register and puts its value in A.
- `p` writes `crazy(A, register)` to both the register and A.
- `/` reads input into A; `<` writes A. Their named register is a D steering
  location and is not changed by the I/O instruction.

A body executes at least once and must leave finite boolean 0 or 1 in A.
One continues; zero halts. For example, this loop echoes a character, then
reads a separate boolean deciding whether to repeat:

```ts
const loop = planAccumulatorLoop({
  width: 20,
  registers: { io: 0 },
  body: [
    { op: "/", register: "io" },
    { op: "<", register: "io" },
    { op: "/", register: "io" },
  ],
});
const program = assembleRegisters({
  width: 20, registers: {}, instructions: [], runtime: loop.runtime,
}, { maxSourceCells: 8_000_000 });
// Input "A\x01B\x01C\0" prints "ABC" and halts.
```

The initializer patches already-consumed code into permanent nops and F/J
instruction pairs. An active traversal flips each operation and steering
instruction into its nop phase. A second traversal restores those cells,
leaving the data unchanged. Its final jump uses a computed continuation word.
Iteration count depends on runtime input and does not increase source size.

`runtime.bindings: [{ cell, source }]` transfers register-backend values after
`instructions` finish and before entering the loop. A target cell must be in
the runtime image; use `loop.symbols.get(name)` for its address. Tests perform
a store/load in the register backend, bind the loaded value into the loop,
print it three times, and verify every active code cell is restored. Both
widths run in TypeScript; width 20 also runs in the C interpreter.

This is a handoff between two execution schemes. Indexed operations and the
arithmetic instruction lists cannot yet be placed directly inside `body`.
The runtime image is an internal ABI, not general user-writable memory.

Initialization remains large (millions of cells for small loops). Common
patch values are cached in unused low registers, and consecutive patch
addresses use a ternary increment instead of rebuilding the whole address.
The caller can raise the source budget explicitly; source size and all
runtime addresses are checked against their respective limits.

## Rotation-width-independent cycle detection

`rotationCycle(registers, step, prefix?)` generates an accumulator-loop body
with no assumed rotation width. `step` runs once per marker rotation. The
physical width must remain stable during the cycle.

```ts
const cycle = rotationCycle(
  { payload: 65 }, [{ op: "*", register: "payload" }],
);
const loop = planAccumulatorLoop({ width: 20, ...cycle });
```

A marker starts at trit 1. Crazy operations detect its return to that position
and produce a selector directly at trit 1; no width-dependent shift is needed
for the continuation pointer. A small constant is read without rotation by
applying the same crazy permutation twice. Rotating the repeating all-ones
word is also independent of physical width.

The same body passes arithmetic checks at widths 10, 11, 13, 15, 20, 31, 64,
and 127. Separately installed native images execute at widths 11, 31, and 64,
restoring both marker and payload. These latter tests inject the runtime image
to isolate execution from installation.

**The rotation-width-independent bootstrap is not complete.** The source
initializer that installs this loop still requires a known width. It must be
replaced by an input-free seed stage that installs the cycle without assuming
its width, stabilizes the maximum D width, and then builds the wide runtime.
The cycle detector supplies loop machinery for that stage, not a complete
width-independent source program.
