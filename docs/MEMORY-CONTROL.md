# Indexed memory, reusable register loops, and bootstrap installation

Register arithmetic and indexed load/store now execute inside reusable native
loops. `assembleBootstrap` separately installs a rotation-cycle bootstrap from
legal source under unknown, growing rotation widths. The original register-loop
backend uses a fixed physical width. `assembleBootstrappedLoop` links register
applications to the bootstrap and implements logical-word rotations
independently of physical rotation width.

## Register loops

`planRegisterLoop` accepts the same instruction lists emitted by `Arithmetic`.
`assembleRegisterLoop` also installs the planned image and returns legal source.
The body executes at least once; its `while` register must contain finite 0 or
1 at the end of each iteration. One repeats and zero halts.

```ts
import { Arithmetic, assembleRegisterLoop } from "./src/hell/index.js";

const width = 20;
const arithmetic = new Arithmetic(width);
const program = assembleRegisterLoop({
  width,
  registers: { ...arithmetic.registers, pointer: 0, value: 64, again: 0 },
  arrays: { data: [0] },
  body: [
    { op: "array-base", dest: "pointer", array: "data" },
    ...arithmetic.increment("value"),
    { op: "store", pointer: "pointer", source: "value" },
    { op: "set", dest: "value", value: 0 },
    { op: "load", dest: "value", pointer: "pointer" },
    { op: "putc", source: "value" },
    { op: "getc", dest: "again" },
  ],
  while: "again",
}, { maxSourceCells: 300_000_000 });
// Input "\x01\x01\0" prints "ABC" and halts.
```

This exact full-width increment/store/load example emits **271,036,418 source
cells** and passes in the external Unshackled-20 interpreter. Source generation
is still expensive. The body is stored once and reused; increasing the runtime
iteration count does not increase the image. The default two-million-cell
source budget must be raised explicitly for these larger programs.

All register instructions are supported: initialization/copy, crazy, rotate,
I/O, array-base, load/store, and the arithmetic width contract. Native reads
reuse A when possible, use the crazy permutation for known finite/base-1
words, and otherwise rotate through the fixed physical width. A spare physical
register handles crazy operations whose output aliases A; parallel moves
restore logical register locations before the next iteration.

Raw input, array elements, and stored values must be finite words fitting the
configured width. EOF/newline sentinels remain raw here; the VM layer translates them.
The Boolean continuation contract and array bounds are caller obligations;
there is no runtime bounds check. Register and pointer aliases are supported.

Tests cover source-installed arithmetic/trit extraction with repeated loads
and stores, wide overwrites, pointer aliases, and full-width carry wraparound
with changing runtime indices. A large runtime-phase test isolates full-width
increment and indexed address calculation; a separate external integration
probe runs the complete 271-million-cell source above.

## Indexed addressing

`array-base` places `base - 1` in a register. `Arithmetic.address` computes
`base - 1 + 3 * index`, preserving the index unless it aliases the output.
It works in both register backends.

The straight-line backend's array frames contain value, self pointer, and
return pointer. They reclaim initialization instructions after execution.
`program.arrays` reports `{ base, length, stride: 3 }`.

The loop backend uses three-cell address proxies and separate value storage.
Two indirect j instructions reach the value; a second pair returns the result
to a capture register. Loads apply the masked crazy permutation twice to read
without changing the value. Stores reset and replace the selected value. The
proxy redirects and return fields survive writes. Inspect
`program.loop.arrays.get(name)` for `{ base, stride: 3, cells }`; `cells` lists
actual value addresses. These layouts are different internal ABIs.

## Accumulator-loop interface

The lower-level `planAccumulatorLoop` API remains available. Its native `*`
and `p` instructions write a named register and A; `/` and `<` perform I/O
through A. Its default body leaves a finite Boolean in A. Selector mode uses
...111 to stop and ...101 to continue, with trits written least significant
first.

An active traversal flips operations and steering instructions into their nop
phase. A second traversal restores those cells without modifying the data.
A computed continuation selects the next iteration or halt. Permanent-nop
padding remains harmless through both passes. The planner tries both legal j
residues when avoiding steering-field collisions.

`runtime.bindings` still supports transferring values from a straight-line
register program into a native loop. This handoff is optional now that full
register instruction bodies can be compiled directly.

Runtime installation caches complements of common image values and uses a
page pointer to write nearby cells. Source buffers and the interpreter's
initial source memory use byte storage; wide values and unbounded addresses
remain sparse.

## Bootstrap without an assumed rotation width

```ts
import { assembleBootstrap } from "./src/hell/index.js";
const bootstrap = assembleBootstrap(20);
```

This emits **11,794,370 legal source cells**. It consumes no input, installs its
own native cycle in dynamically addressed memory, and halts with payload
`2 * 3^20`. The shift argument accepts 0..30. The generated source has no host
memory injection, rotation-policy parameter, or guessed full rotation count.
It requires conforming Unshackled growth, not the fixed-width C dialect.

Six rotations of finite 2 produce movable seed bits. Their bank addresses
have known residues modulo 94 despite unknown absolute widths. The installer
widens twice through a return cell that works whether it is unexecuted source,
encrypted source, or generated memory. Two widenings guarantee a width of at
least 34 before the final bank seeds are made. Those banks therefore lie far
beyond the source image. Crazy-based reads preserve bank words even if the
physical rotation width subsequently grows.

The installed cycle uses an inverted-phase j during restoration to reach a
fixed continuation register. This avoids having to construct a wide pointer
to an arbitrary offset within the restoring traversal. After the installer
has visited the largest D width, marker rotation is stable. Pre-rotating the
marker by the requested shift makes the cycle rotate the payload by the
complementary count, yielding `2 * 3^shift`.

Tests execute this source under minimal and seeded-random growth, inspect the
wide result and restored marker, and run the unrestricted-width C interpreter.
`basisRegister` and the symbolic `symbols` map are diagnostic metadata: read
the basis register and divide by two to resolve `bank * basis + offset`.

## Applications linked to the bootstrap

`assembleBootstrappedLoop(program, options?)` accepts a `RegisterLoopProgram`.
Its `width` is a logical word size from 10 through 20; the physical rotation
width is determined by the interpreter. The source performs three widening
operations, calibrates a low seed at trit 30, returns to the source installer,
installs the application in bank-relative memory, and enters its do/while loop.
Installation consumes no input and needs no host memory writes.

```ts
import { assembleBootstrappedLoop } from "./src/hell/index.js";
const program = assembleBootstrappedLoop({
  width: 10,
  registers: { value: 65, again: 0 },
  body: [
    { op: "putc", source: "value" },
    { op: "getc", dest: "again" },
  ],
  while: "again",
});
// Input "\x01\0" prints "AA" and halts.
```

See `examples/bootstrapped-register-loop.ts` for the source generator. This
backend is experimental: this small example emits **49,558,400 source cells**
and initializes **15,609 native image cells**. The default source budget is
500 million cells. Large arithmetic expansions can exceed either that budget
or the available register banks.

`planBootstrappedLoop` exposes symbolic patches for inspecting the larger
native runtime separately from installation. In either API, `applicationSymbols`
and array `cells` contain `{ bank, offset }` addresses. Resolve them using
`bank * basis + offset`, where `basis` is half the final value of `basisRegister`.
Array pointers in application registers are logical offsets into the proxy
table, not resolved machine addresses. `array-base` and `Arithmetic.address`
construct these offsets. `codeCells` counts initialized native image cells.

The backend implements register copies, crazy operations, finite input/output,
logical rotations, and indexed load/store with pointer aliases. Repeating
base-1 constants are available to arithmetic circuits. Modified registers must
start finite and are normalized to the logical word at loop boundaries when
their prior value is needed. Logical rotations require finite values; input
must fit the logical word and must not contain the EOF/newline sentinels.
Continuation values must be finite booleans, and array indices must be in bounds.

Logical rotation combines a physical right rotation with a shared marker cycle
that shifts the wrapped segment left. A crazy circuit clips both segments to
their logical masks before combining them. Cycle calls write a return pointer;
the exit jumps directly through that pointer, so repeated calls do not consume
a nonrestorable return instruction. The loop condition uses the low trit directly
and does not need a rotation cycle.

Regression tests install and repeat the small application from legal source
under minimal and seeded-random growth and run the unrestricted C interpreter.
Separate runtime tests cover logical rotations, arithmetic trit extraction,
repeated indexed stores/loads, and pointer aliases at logical widths 10 and 20
with different physical widths. These larger tests install symbolic patches
directly; they do not claim a full-source arithmetic benchmark. A separate
HeLL VM now links all 24 portable bytecode opcodes to this bootstrap, with
shared handlers and bounded data/return stacks. See `VM.md` for its format,
full-source coverage, and current costs.
