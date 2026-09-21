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
  trit-value library. Used by tests and the CLI's `run` command.
- `hell/`: HeLL parser and assembler producing Malbolge Unshackled.
- `vm/`: bytecode ISA and a TypeScript reference implementation of the VM.
- `runtime/`: the VM written in HeLL, plus the arithmetic macro library.
- `frontend/`: acorn parse, subset checker, IR lowering, bytecode emission.
- `cli/`: `js2mb compile` and `js2mb run`.

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
