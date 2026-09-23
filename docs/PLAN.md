# js-to-malbolge: project plan

Goal: a TypeScript library and CLI that compiles a subset of JavaScript to
Malbolge Unshackled.

## Decisions (2026-09-21)

- **Target**: Malbolge Unshackled (unbounded memory and word width). Standard
  Malbolge (59,049 cells) is supported by the interpreter for testing and may
  later be an output mode for tiny programs.
- **JS subset, Tier 1**: integers, booleans, strings as char arrays, `let`/`const`,
  arithmetic, comparisons, `if`/`while`/`for`, functions without closures,
  arrays, `console.log`. Tier 2 (later): closures via lambda lifting,
  fixed-shape objects, input. Out of scope: floats, regex, prototypes, async.
- **Clean room**: the HeLL runtime and assembler are written from the language
  specifications. No code from existing Malbolge tooling is copied. Existing
  interpreters and programs are used only as external test oracles and
  fixtures, fetched by `scripts/fetch-vendor.sh` into the gitignored `vendor/`.
- **Parser**: acorn.

## Architecture

Every compiled program is "fixed VM + program bytecode as data":

1. A small stack VM is written once in HeLL (an assembly-like language for
   Malbolge) and assembled to Malbolge Unshackled.
2. JavaScript is parsed, lowered to an IR, then to bytecode for that VM.
3. The bytecode is emitted as a data section appended to the VM image.

Modules (all under `src/`):

- `malbolge/`: interpreters for standard Malbolge and Malbolge Unshackled, a
  trit-value library. Used by tests and library callers.
- `hell/`: HeLL parser and assembler producing Malbolge Unshackled, arithmetic
  macros, and the bootstrap/runtime linker.
- `vm/`: bytecode ISA, portable codec, assembler/disassembler, TypeScript
  reference interpreter, and native HeLL interpreter.
- `frontend/`: acorn parse, scalar subset checker, symbolic IR lowering, bytecode emission.
- `cli.ts`: `js2mb compile`, `js2mb assemble`, `js2mb disassemble`, and `js2mb link`.

## Milestones

1. Interpreters pass on published programs (hello world, cat) and match the C
   reference interpreter.
2. HeLL assembler: "cat" then a counter loop assemble and run identically on
   our interpreter and the reference interpreter.
3. Arithmetic library in HeLL: increment, add, subtract, compare, indexed
   load/store, each tested against the TypeScript oracle.
4. VM in HeLL runs hand-written bytecode (fizzbuzz) matching the TS VM.
5. Frontend: Tier 1 JS to bytecode, tested against Node on the same source.
6. End to end: Tier 1 programs compile to Malbolge Unshackled and run
   correctly. CLI and test corpus.
7. Tier 2 features, size and speed work.

## Milestones 3 and 4 review (2026-09-21)

Milestone 3 is **partial**. `src/hell/macros.ts` now supplies a small-constant
loader for 0..80 from a known accumulator. Its P block must have an explicit
`address`, because the legal operand constants differ between placements 81
and 85. All 81 × 81 transitions at both placements are checked against the
TypeScript trit oracle. Assembled programs cover ternary boundaries, inspect
result cells at widths 10 and 20, and match both external C interpreters.

The computed-MovD regression now writes source value 123 into runtime value
237 using EOF, then jumps to tape address 238 and halts. Its register contents
and output are checked in both TypeScript machines; output is also checked
with both C interpreters. The former value-74 fixture was impossible under
the static placement constraints, and also incorrectly assumed A=0 after
double-j entry patching. This fixes the regression fixture, not the general
packing problem. See `BOOTSTRAP.md` for the constraints discovered in review.

Milestone 4 has a **working TypeScript reference**, textual bytecode assembler,
and `examples/fizzbuzz.vm`. The 21-instruction ISA covers signed modular
arithmetic, shared locals, branches, explicit data/return stacks, and character
I/O. At either width 10 or 20, fizzbuzz uses 73 logical instructions, executes
4,251 VM steps, and prints 413 UTF-8 bytes (1 through 100). These are reference
VM measurements; the native follow-up below now covers compiled JS FizzBuzz. See `VM.md` for
the versioned bytecode ABI and native interpreter described below.

## Fixed-width arithmetic implementation (2026-09-21)

`src/hell/init.ts` now assembles fixed-width register programs with input-free
wide initialization, arbitrary register overwrites/copies, and directives for
wide data cells. `src/hell/arithmetic.ts` supplies reusable generators for
trit extraction, increment, add, subtract, signed/unsigned less-than, and
equality. The instructions operate on runtime values and support output/input
aliases. Word arithmetic wraps modulo `3^width`, matching the reference VM's
word representation. Both widths 10 and 20 are tested; every arithmetic macro
also runs against the fixed-width C oracle with multiple input values.

The new register backend runs straight-line code above the low data bank,
avoiding the original rotation/double-j placement conflict. It is separate
from the original block/tape assembler. It currently has 22 register slots
and unrolled arithmetic; a width-20 two-input addition example emits 154,485
cells and executes 154,370 Malbolge steps. Small initialization-only images
also pass on standard Malbolge, while arithmetic images exceed its size limit.
See `FIXED-ARITHMETIC.md` for the API, construction, limits, and measurements.

Indexed load/store now operates on initialized three-cell array frames, with
runtime indices, pointer aliases, and wide overwrites checked at widths 10 and
20 and against the C oracle. Restorable accumulator loops execute repeated
iterations from one code image. A runtime binding connects the register
backend's computed values to those loops. `planRegisterLoop` and
`assembleRegisterLoop` now accept the complete arithmetic/register instruction
lists directly, including indexed load/store. The full increment/store/load
source runs three input-controlled iterations in Unshackled-20 and prints
`ABC`; it currently occupies 271,036,418 source cells.

A rotation-cycle body now detects an unknown physical width without assuming
a rotation count. Its installed native image passes at widths 11, 31, and 64,
and its arithmetic is checked through width 127. `assembleBootstrap` now
installs a compact cycle from legal source without a known width or input.
Two safe widening operations create dynamically located banks, and a
restoration-only j supplies the continuation. An 11,794,370-cell bootstrap
builds `2 * 3^20` under growing TypeScript policies and terminates in the
unrestricted-width C oracle. See `MEMORY-CONTROL.md` for APIs and validation.

The fixed-width milestone-3 operations now execute inside reusable control
flow. Source size and startup cost need substantial improvement. Application
linkage is now available through `assembleBootstrappedLoop`: legal source calibrates
the bootstrap, installs a bank-relative register application, and enters its
reusable loop. Finite logical rotations use the shared marker cycle rather
than an assumed physical width. An input-controlled two-iteration application
prints `AA` and halts under growing TypeScript policies and the unrestricted
C interpreter. Larger runtime-phase tests cover rotations, arithmetic trit
extraction, indexed memory, and pointer aliases at logical widths 10 and 20.
Those tests isolate the native runtime rather than installing their full source.
The linked backend remains experimental: even small source images occupy tens
of millions of cells, and large arithmetic expansions can exceed its source
or register-bank budgets. See `MEMORY-CONTROL.md` for contracts and coverage.
The original tape packer's allocation/caching limitations remain unresolved.

## Native bytecode interpreter (2026-09-21)

Milestone 4 now has a versioned binary format, a canonical disassembler, and
native handlers for all 21 opcodes. The initial push/putc/halt implementation
retains its compact literal layout. The complete interpreter adds shared
register microcode for locals, stack manipulation, arithmetic, comparisons,
branches, calls, and input, with explicit faults and bounded data/return stacks.
Arithmetic loops over word digits; rotation and opcode routines are shared.

`assembleHeLLVM` links either layout to the unknown-width bootstrap. Installer
mask/value caching and closer anchors reduce the seven-instruction `AB\n`
image from 59,077,028 to 43,877,510 cells at stack capacity one. It passes growing
TypeScript policies and the unrestricted C oracle. Compiled JS arithmetic also
runs from legal source in the TypeScript machine. Model tests cover the complete
ISA and compiled functions/decimal output; full-source native FizzBuzz was the next milestone gate, now covered by the
follow-up below. Source size, runtime, and C loader memory costs still limit
larger programs. See `VM.md` for measurements and validation layers.

## JavaScript frontend (2026-09-21)

Milestone 5 is partial: the scalar JS subset now compiles to the shared bytecode
format. It includes lexical variables, integer/boolean expressions, loops and
branches, top-level functions, recursive activation records, and `console.log`.
FizzBuzz and a semantic test corpus agree with Node within the documented
integer semantics. The CLI emits bytecode, assembly, or linked Malbolge;
the native interpreter supports every emitted opcode. Remaining Tier 1 frontend
work includes arrays and general strings. Full-source testing of larger compiled
programs and source/runtime costs remain end-to-end gates. See `JAVASCRIPT.md`.

## Native execution and immediate instructions (2026-09-22)

Compiled JS FizzBuzz now runs from legal Malbolge source under the minimal
growing-width policy and matches the reference output and successful halt.
This covers one complete fixture for milestones 4 and 6; arrays, general strings,
and wider end-to-end corpus coverage remain open.

The ISA adds `modi`, `putci`, and `divi` at IDs 21 through 23 without renumbering
existing instructions. The compiler, reference interpreter, codec, assembler,
disassembler, and native backends all support them. Small constant divisors use
finite-state digit tables; literal output avoids data-stack traffic. Shared digit
scans replace expensive arithmetic comparisons, and carry propagation exits early.

The Unshackled interpreter batches no-ops while preserving encryption, observable
memory, step limits, and register state. Differential tests compare it with scalar
stepping, including self-modification and address carries across repeating bases.
`pnpm bench:vm` records full-source or explicitly isolated runtime measurements;
see `NATIVE-PERFORMANCE.md` for results and remaining costs.

## Compression follow-up

- Frontend constant folding, basic-block propagation, reachability, unused-store
  removal, and fusion into existing immediate instructions.
- Tighter data frames, omitted unused literal fields/stacks, shorter immutable
  constant reads, and periodic remainder-table states.
- Explicit size/speed arithmetic modes and conservative default stack sizing.
- A native run decoder with radix-three loops, target-generated padding, and a
  source continuation for exceptional cells; unrolled fresh-cell writes also
  use shorter initialization recipes.
- Exact phase-level source statistics, CLI switches, and reproducible size
  comparisons. The native decoder is covered by carry/fill-phase tests and a
  complete source bootstrap/application test. Large-image execution remains
  expensive; source-size measurements do not claim a native timing improvement.

## Assembly tooling follow-up

The bytecode assembler now supports exact integer expressions and radix literals,
forward constants, named locals, scoped labels, Unicode output directives,
assertions, and relative includes. Diagnostics and instruction source maps retain
file/line/column locations. Optional symbol sidecars are tied to binary hashes.
The disassembler restores labels from these maps, emits annotated decimal/hex/
ternary listings that reassemble byte for byte, and provides JSON inspection
with exact instruction offsets and bytes. The MBVM version-1 format and all
24 opcode IDs are unchanged. See `ASSEMBLY.md` and `examples/assembler-demo.vm`.

## Reference semantics (from the public-domain reference interpreters)

Standard Malbolge (Olmstead 1998):
- 59,049 words of 10 trits. A, C, D start at 0.
- Load: skip whitespace; each char must be 33..126 and
  `(char + index) % 94` in {4,5,23,39,40,62,68,81}. Remaining cells:
  `mem[i] = crazy(a = mem[i-1], d = mem[i-2])`.
- Dispatch on `(mem[C] + C) % 94`: 4 jmp (`C = [D]`), 5 out (`putc(A & 255)`),
  23 in (`A = getc`, EOF gives 59048), 39 rotr (`A = [D] = rotr([D])`),
  40 movd (`D = [D]`), 62 crazy (`A = [D] = crazy(A, [D])`), 68 nop, 81 halt.
  Any other value is a nop at runtime (but invalid in source).
- If `mem[C]` is outside 33..126 the machine hangs forever.
- After each instruction: `mem[C] = xlat2[mem[C] - 33]` using the *new* C
  (so a jump encrypts its target cell and resumes at target + 1), then C and D
  increment modulo 59049.
- Crazy op, tritwise, indexed `[dTrit][aTrit]`: `[[1,0,0],[1,0,2],[2,2,1]]`.

Malbolge Unshackled (Johansen 2007), differences:
- Values are 3-adic integers: a finite trit list plus an infinitely repeating
  leading trit ("base"). Canonical form drops repeated leading trits.
- Memory is unbounded; a cell beyond the program is initialised from a table of
  six values derived from the last two program chars (`rArr`), indexed by the
  address's mod class `(base * 29524 + offset) mod 282`, mod 6.
- The rotation width is not fixed. It starts at 10..15 and may grow whenever a
  `movd` sets D to an address wider than any seen before; the interpreter
  guarantees only `rotWidth >= 2 * maxDWidth`. Rotation acts on the low
  `rotWidth` trits; higher trits are unchanged.
- Output: base-0 value prints its Unicode code point; `...222` closes stdout;
  `...221` prints newline; anything else crashes. Input: EOF gives `...222`,
  newline gives `...221`, otherwise the code point.
- Executing a cell outside 33..126 hangs; encrypting one crashes.
