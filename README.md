# js-to-malbolge

Compile your JavaScript files to **Malbolge Unshackled**. This is a work in
progress: it supports an integer-based JavaScript subset, so arbitrary Node.js
or browser programs need adapting before they can compile. The output requires
an Unshackled interpreter, rather than a standard Malbolge interpreter.

From the repository root, install dependencies and build the CLI using Node.js
and pnpm (the project pins pnpm 10.6.2):

```sh
pnpm install
pnpm build
```

To convert your own file, replace `path/to/program.js` with its path:

```sh
node dist/cli.js compile path/to/program.js -o /tmp/program.mb
```

`compile` emits Malbolge Unshackled source by default. For a first example, save
this as `program.js`:

```js
console.log("Hi");
```

Compile it, fetch/build the reference interpreter (requires `curl` and `gcc`),
and run the generated source:

```sh
node dist/cli.js compile program.js -o /tmp/program.mb
pnpm fetch-vendor
vendor/interp/unshackled /tmp/program.mb
```

The program prints `Hi` followed by a newline. Fetching the interpreter is only
needed once; it is optional if you already have an Unshackled interpreter.
Even small native programs produce files tens of megabytes in size, and native
startup/execution can be very slow. See [native performance](docs/NATIVE-PERFORMANCE.md)
before trying a larger program.

You can also pipe JavaScript into the compiler. Use `-` for stdin; omitting `-o`
writes the generated source to stdout:

```sh
printf '%s\n' 'console.log("Hi");' | node dist/cli.js compile - > /tmp/program.mb
```

Supported code includes initialized `let`/`const`, integers and booleans,
arithmetic, conditions, loops, top-level function declarations, recursion, and
`console.log`. Strings are supported as literal `console.log` arguments.
Arrays, objects, general string operations, arrow functions, closures, `var`,
imports, classes, exceptions, and async code are unsupported. Node.js and browser
APIs such as `fs`, `fetch`, and the DOM are unavailable. Unsupported code fails
with a filename, line, and column; see the full
[JavaScript subset](docs/JAVASCRIPT.md) when adapting your program.

Numbers use fixed-width integer arithmetic: division truncates toward zero,
and arithmetic wraps modulo `3^width`. The default `--width 20` represents
-1,743,392,200 through 1,743,392,200; floating-point JavaScript semantics are
unsupported. Native output supports widths 10 through 20.

For larger inputs, first check that your source compiles to compact bytecode or
inspect its VM assembly, then link the bytecode to Malbolge:

```sh
node dist/cli.js compile path/to/program.js --emit bytecode -o /tmp/program.mbc
node dist/cli.js compile path/to/program.js --emit assembly -o /tmp/program.vm
node dist/cli.js link /tmp/program.mbc -o /tmp/program.mb
```

The `.mbc` and `.vm` files are intermediate formats, not Malbolge source.
Both native stacks default to 16 words. Recursion and decimal number output may
require increasing `--stack-capacity` and `--return-stack-capacity` on `compile`
or `link`. Linking can also exceed the default 500-million-source-cell budget;
`--max-source-cells` changes that budget but does not reduce memory requirements.
See [VM usage and limits](docs/VM.md) for details.

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

To work directly with VM assembly:

```sh
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

The installed command is `js2mb`; for example,
`js2mb compile program.js -o /tmp/program.mb`.
Run `node dist/cli.js --help` for CLI options, or
`pnpm test --maxWorkers=1` to run the test suite.

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
