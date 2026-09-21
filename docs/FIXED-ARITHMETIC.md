# Fixed-width initialization and arithmetic

`assembleRegisters` emits executable Malbolge source for a `RegisterProgram`.
Initialization runs on the target machine without consuming input or injecting
interpreter memory. It builds finite wide words and repeating-base-1 masks,
then executes register instructions. Widths 10..20 are accepted; 10 and 20
are tested against the fixed-width TypeScript machines, with width 20 also
checked against the external Unshackled-20 interpreter.

This is a separate register backend alongside the original block/tape
assembler. The original `Program` and `assemble` API remain available. The new
backend avoids the rotation/double-j collision by using straight-line code
above address 126 and a low-address data bank. Its arithmetic macros can be
invoked repeatedly with different runtime values, but their instruction
sequences are unrolled. `assembleRegisterLoop` can now execute those same
instruction lists repeatedly from a restoring native image; see
`MEMORY-CONTROL.md` for that API and its current size costs.

## API

```ts
import { Arithmetic, assembleRegisters } from "./src/hell/index.js";

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
```

Input ` !` prints `A`. [`examples/wide-arithmetic.ts`](../examples/wide-arithmetic.ts)
generates this program:

```sh
node --import tsx examples/wide-arithmetic.ts > /tmp/wide-arithmetic.mb
printf ' !' | vendor/interp/unshackled20 /tmp/wide-arithmetic.mb
```

| Width | Source cells | Initialization end (exclusive) | Executed Malbolge steps |
| --- | ---: | ---: | ---: |
| 10 | 87,750 | 46,189 | 87,635 |
| 20 | 154,485 | 63,134 | 154,370 |

Counts exclude a trailing source-file newline and use the TypeScript
interpreter's step convention (halt is not counted). These arithmetic images
exceed standard Malbolge's 59,049-cell limit; smaller initialization-only
programs are also tested directly on the standard machine.

The result includes `source`, `image`, `symbols` (register addresses), `width`,
`initializationEnd`, and `codeEnd`. Each declared register is initialized from
a number, bigint, or canonicalizable LSB-first trit string. Integers wrap
modulo `3^width`; strings may use repeating base 0 or 1 and at most `width`
explicit trits. Base 2 cannot be synthesized without input and is rejected.

Optional `initialize: [{ cell, value }]` directives write data beyond the
executable code, including wide tape words. Targets must fit the declared
address width; the assembler reserves source-legal return steering cells
after them and rejects overlap with executable code. A regression initializes
cell 50,000 to 12,345 on both widths and on standard Malbolge at width 10.
The optional second argument `{ maxSourceCells }` bounds emitted code and
sparse data padding; the default is two million cells.

Primitive instructions are `set`, `copy`, `crazy`, `rotate`, `getc`, and `putc`.
`crazy` takes `dest`, `a`, and `b`, computing `crazy(a,b)` while preserving
operands other than `dest`. Copies and crazy operations support aliases.
Rotation counts are nonnegative and reduced modulo the declared width.
`getc`/`putc` retain the target machine's raw I/O semantics. Arithmetic operands
must be finite words within the width; EOF/newline sentinels and oversized
input values require translation by a future VM I/O layer.

## Arithmetic macros

One `Arithmetic` instance declares 18 private registers. Include its
`registers` once; its optional prefix changes private names. The backend has
22 register slots, leaving four application registers when using the complete
arithmetic set. Private names must not overlap application names. Operations
share scratch storage and are intended to execute sequentially.

- `increment(dest, source = dest)`, `add(dest, a, b)`, and
  `subtract(dest, a, b)` compute modulo `3^width`.
- `lessThan(dest, a, b, signed = true)` produces 0 or 1. Signed mode interprets
  words using the reference VM's centered signed range; `false` selects
  unsigned comparison.
- `equal(dest, a, b)` produces 0 or 1.
- `trit(dest, source, index)` extracts a trit as 0, 1, or 2.

Public operands may alias the output. Non-output operands are preserved.
Methods return register instruction lists; no runtime result is evaluated by
the compiler. They include a compile-time `require-width` directive so the
assembler rejects macros built for a different rotation width. The same
generated source is tested with multiple external
inputs. Every arithmetic macro is checked on both TypeScript widths, with
ternary/carry/sign boundaries compared to bigint. Width-20 programs for each
macro also match the C oracle, dumping all result trits.

## Construction

The low bank holds immutable ...111 and finite 2, three work registers, and an
address register. Cells adjacent to the work registers contain self pointers,
so a batch of `width` rotations reads a value into A and restores the register.
Source-legal steering cells return D to bank address 39.

With A=...111, two consecutive crazies on a register reset it to ...111;
a third makes it zero. For copying, crazy with an all-ones destination swaps
trits 0 and 1 and leaves 2 unchanged. Applying that permutation twice copies
the original value. This works with arbitrary prior destination contents.

A finite word is constructed from zero, inserting nonzero trits at the low
position and rotating. Two masks with repeating base 1 preserve other trits:
two ...1112 masks change low 0 to 1; ...111 followed by ...1112 changes it to 2.
Leading zero insertions are omitted. Base-1 values use the same copy permutation
on a finite preimage. The generated source never assumes source words can
directly contain wide values.

Addition and subtraction use tritwise sum/difference and carry/borrow circuits
derived from the crazy truth table. Carry/borrow words rotate left and clear
the wrapped low trit, then feed the next iteration. Exactly `width` iterations
cover every possible propagation chain. Unsigned comparison collects outgoing
borrows; signed comparison first biases each operand by `(3^width-1)/2` modulo
the word range. Equality reduces per-trit nonzero indicators with cyclic OR.
All circuits preserve a zero repeating base for finite arithmetic results.

Indexed access and full arithmetic instruction lists now execute inside
restorable register loops. `assembleBootstrappedLoop` now links register
applications to an input-free bootstrap and implements finite logical-word
rotations without assuming a physical rotation width. This backend has large
source costs and finite-value restrictions; see `MEMORY-CONTROL.md`. An initial
HeLL VM now supports `push`, `putc`, and `halt`; integrating these arithmetic
operations into its opcode handlers remains open. See `VM.md`.
