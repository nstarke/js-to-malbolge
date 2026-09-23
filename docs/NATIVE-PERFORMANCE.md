# Native execution measurements

The benchmark compiles JavaScript, installs the interpreter from legal Malbolge
Unshackled source, executes it, and checks both output and the native halt address.
It does not inject the VM image or substitute host arithmetic for VM execution.

```sh
pnpm bench:vm examples/fizzbuzz.js --seconds 3600 --report /tmp/fizzbuzz.json
```

Defaults are logical width 10, data/return stack capacities 16, a 3,600-second
execution limit, and 100 billion Malbolge instructions. Compilation and source
loading are timed separately from execution. Progress goes to stderr; stdout
and `--report` receive JSON. Exit status is 0 for matching output and successful
halt, 2 for an execution limit, and 1 for a fault, mismatch, or invalid input.

`--mode runtime` deliberately bypasses installation, resolving symbolic patches
at basis `3^60`. It profiles the native handlers but is not a full-source test.
Both modes use the minimal growing-width policy. Other options are `--width`,
`--max-steps`, `--stack-capacity`, and `--return-stack-capacity`.

## Compression modes (September 22 follow-up)

```sh
# Default arithmetic and installer, with exact source attribution:
node dist/cli.js compile examples/fizzbuzz.js --width 10 --stats /tmp/default.json -o /tmp/default.mb
# Smaller arithmetic and a reusable target-side padding decoder:
node dist/cli.js compile examples/fizzbuzz.js --width 10 --optimize size --installer loop --stats /tmp/small.json -o /tmp/small.mb
# Reproduce every source-size measurement below (no program execution):
pnpm bench:size --report /tmp/compression.json
```

[Saved measurements](benchmarks/compression-width10.json) include the environment,
exact phase counts, native code cells, bytecode sizes, and compilation times.
MB below means one million source cells/ASCII bytes, without external compression.

| FizzBuzz, width 10 | Source cells | Reduction from 429,208,232 |
| --- | ---: | ---: |
| Speed arithmetic, unrolled installer (default) | 324,757,124 | 24.3% |
| Speed arithmetic, loop installer | 286,053,752 | 33.4% |
| Size arithmetic, unrolled installer | 301,469,846 | 29.8% |
| Size arithmetic, loop installer | 269,407,010 | 37.2% |

The default still uses faster constant-division tables. Size mode uses shared
general division/remainder instead and conservatively shrinks default stacks
where possible. Explicit capacities are honored; recursive calls keep the
default bound. The loop installer adds substantial startup execution, so the
smallest source is not a claim of fastest execution. It is bypassed for images
with fewer than 200,000 native code cells.

The installer now constructs shared address bases and uses short forward deltas,
with wider intervals for sparse data than for dense code. Fresh cells need two
writes instead of three. The reusable decoder fills native code with 74 using
radix-three loops, then returns to source to install exceptional cells. Its
internal `padstep` primitive changes a known pointer trit without general integer
arithmetic or a guessed rotation width. No new portable opcode is needed.

Data frames use a 564-cell stride rather than 752. Literal programs omit unused
fields and stack frames. Immutable 0/2 constants have shorter native reads, and
remainder tables share periodic positional states. The frontend folds modular
constants, propagates basic-block constants, removes unreachable code and unused
stores, and fuses into existing immediate operations. Syntax/type validation
still covers unreachable source; calls and loops are not evaluated on the host.

At width 20, `console.log("AB")` with stack capacity 1 is **36,056,804** cells,
down another 2.2% from the previous 36,883,628. Constant-folded
`console.log(19 + 23)` in size mode is **36,038,192** cells, down **91.1%** from
405,013,478. Both compile to four bytecode instructions. About 28.7 MB of the
linked calibration stage remains even for tiny programs.

Full FizzBuzz also matches the independent microcode model in both arithmetic
modes: 247,313 microsteps for speed and 1,901,437 for size, with all 413 output
bytes matching and fault 0. These are model steps, not native timing estimates.

The decoder is tested across all six initial fill phases, ternary carries, and
random growth, plus a complete legal-source bootstrap/decoder/application run.
The source-size matrix above does **not** include a new full FizzBuzz execution
for every combination. The full-source FizzBuzz timing below belongs to the
pre-compression image and must not be treated as a timing for these modes.

## Before the compression follow-up

Measured locally on Linux x64, Node v20.11.1, Intel Core i9-13900H. A source cell
is one ASCII byte; native code cells count the installed handler code, excluding
data frames and most bootstrap installation work.

| Compiled JavaScript | Width | Stack capacity | Instructions | Source cells | Native code cells |
| --- | --- | --- | --- | --- | --- |
| `console.log("AB")` | 20 | 1 | 4 | 36,883,628 | 12,400 |
| `console.log(19 + 23)` | 20 | 16 | 32 | 405,013,478 | 414,802 |
| `examples/fizzbuzz.js` | 10 | 16 | 80 | 429,208,232 | 413,862 |

The previous push/putc literal program used seven instructions, 43,877,510 source
cells, and 24,330 native code cells. Immediate output reduces its source by
about **16%** and native code by **49%**. The FizzBuzz bytecode is 258 bytes.

The independent microcode model executes full FizzBuzz in **243,914 microsteps**,
down from **11,348,959** before this follow-up: about **46.5 times fewer**. These
are microinstructions, not Malbolge instructions or a native timing estimate.
Improvements include immediate character output, digit-table division/remainder
for small constants, direct trit comparisons, and early carry termination.

This is a size/runtime tradeoff for general arithmetic. The earlier width-10
FizzBuzz image occupied 295,083,674 cells, and the earlier width-20 numeric
example occupied 287,471,930. Faster native primitives and arithmetic tables
increase those images despite reducing their bytecode and execution work.
Further installer and native-handler compression remains necessary.

## Full-source verification

The intermediate implementation before `divi` completed FizzBuzz from a
433,525,088-cell image: 413 matching output bytes, fault 0, and 29,589,630,290
Malbolge steps. Execution took 3,412 seconds on this machine. This established
the full-source milestone and identified decimal division as a major cost.

The pre-compression constant-division implementation completed the same full-source run
in **15,130,493,734 Malbolge steps** with all **413 output bytes matching** and
fault 0. Execution took **1,320 seconds (22 minutes)**, with another 38 seconds
for compilation and 2.9 seconds for loading. The source contains 429,208,232
cells. The [saved benchmark report](benchmarks/fizzbuzz-width10.json) includes
the complete output and exact counters. This is a **48.9% step reduction** from
the intermediate implementation; elapsed times are local observations rather
than a controlled timing comparison.

The ordinary suite separately checks full-source compiled arithmetic and literal
output, native signed arithmetic at widths 10 and 20, and all ISA routines
against the independent microcode model. Smaller output images also run in the
external C oracle. The large FizzBuzz image is verified with the byte-backed
TypeScript interpreter because the C loader's per-cell allocation exceeds
available memory at this size.

## Interpreter acceleration

`UnshackledMachine.run()` batches source no-ops while applying every encryption.
For installed sparse code, it caches only spans whose entire encryption cycles
are no-ops, tracks their encryption lazily, and materializes a span before any
explicit write to one of its cells. Public reads always see the current value.
Neither path skips arithmetic, I/O, branches, nor rotation-policy decisions.
Step counts and stopping limits still count every Malbolge instruction.

`machine.run(limit, false)` disables batching for differential checks; `step()`
always executes one scalar instruction. Tests compare registers, memory,
encryption phases, output, halts, pauses, code writes, and address carries across
all three repeating bases. `batchedNopSteps` reports the work batched by `run`.

The full-source FizzBuzz benchmark is intentionally separate from the ordinary
test suite because it is expensive. Broader program coverage, full-source width
20 FizzBuzz, and additional growth policies remain follow-ups.
