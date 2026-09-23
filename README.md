# js-to-malbolge

Compile a subset of JavaScript to Malbolge Unshackled. Work in progress; see
`docs/PLAN.md` for the design and milestones.

```sh
pnpm install
pnpm fetch-vendor   # optional: reference interpreters and fixtures for tests
pnpm test --maxWorkers=1
```

Current components: interpreters, a block/tape HeLL assembler, a fixed-width
register backend with wide initialization, arithmetic, and indexed memory;
reusable register loops linked to an input-free bootstrap with unknown rotation
width, and a bytecode VM with assembly, disassembly, and a versioned binary
format. A JavaScript frontend now compiles scalar expressions, variables,
control flow, functions, recursion, and console output into that bytecode.
The native HeLL VM and reference VM implement all 24 bytecode opcodes, including
arithmetic, locals, branches, calls, and character I/O. Immediate character
output and constant division/remainder have compact shared handlers.
See [milestone status](docs/PLAN.md),
[arithmetic usage](docs/FIXED-ARITHMETIC.md),
[memory and control-flow APIs](docs/MEMORY-CONTROL.md),
[VM bytecode and tools](docs/VM.md), the
[assembly language guide](docs/ASSEMBLY.md), and the
[JavaScript subset and compiler](docs/JAVASCRIPT.md). A hand-written fixture lives in
[`examples/fizzbuzz.vm`](examples/fizzbuzz.vm).

Build and use the bytecode tools:

```sh
pnpm build
node dist/cli.js compile examples/fizzbuzz.js --emit bytecode -o /tmp/fizzbuzz.mbc
node dist/cli.js compile examples/hello.js --stack-capacity 1 -o /tmp/hello.mb
node dist/cli.js assemble examples/hello.vm -o /tmp/hello.mbc
node dist/cli.js disassemble /tmp/hello.mbc
node dist/cli.js link /tmp/hello.mbc --stack-capacity 1 -o /tmp/hello.mb
```

The assembler supports integer expressions, constants, named locals, scoped
labels, relative includes, assertions, and Unicode strings. Optional symbol
maps preserve names and source locations. The disassembler emits reassemblable
listings with byte offsets, decimal/hex/ternary immediates, or JSON inspection:

```sh
node dist/cli.js assemble examples/assembler-demo.vm -o /tmp/demo.mbc --map /tmp/demo.map.json
node dist/cli.js disassemble /tmp/demo.mbc --symbols /tmp/demo.map.json --annotate --radix hex
node dist/cli.js disassemble /tmp/demo.mbc --format json
```

The installed command is `js2mb`. Native images remain very large; see
[VM usage and limits](docs/VM.md) before linking larger programs.

Benchmark compiled JavaScript through the full native bootstrap:

```sh
pnpm bench:vm examples/fizzbuzz.js --seconds 3600 --report /tmp/fizzbuzz.json
```

The benchmark checks native output and the halt target against the reference VM.
See [native performance measurements](docs/NATIVE-PERFORMANCE.md) for costs and
for the separate runtime-only profiling mode.

Native compression options are available through `compile` and `link`:

```sh
node dist/cli.js compile examples/fizzbuzz.js --width 10 --optimize size --installer loop --stats /tmp/fizzbuzz-size.json -o /tmp/fizzbuzz.mb
pnpm bench:size --report /tmp/compression.json
```

`--optimize size` trades arithmetic speed for space; `--installer loop` trades
startup work for a smaller large image. The default keeps faster arithmetic and
unrolled installation. Constant folding and dead-code removal are enabled by
default; `--no-optimize` disables frontend simplification. See
[measurements and limits](docs/NATIVE-PERFORMANCE.md).
