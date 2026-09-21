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
format. The initial HeLL VM executes `push`, `putc`, and `halt`; the reference
VM supports the complete ISA. JavaScript compilation is not implemented yet.
See [milestone status](docs/PLAN.md),
[arithmetic usage](docs/FIXED-ARITHMETIC.md),
[memory and control-flow APIs](docs/MEMORY-CONTROL.md), and the
[VM bytecode and tools](docs/VM.md). A hand-written fixture lives in
[`examples/fizzbuzz.vm`](examples/fizzbuzz.vm).

Build and use the bytecode tools:

```sh
pnpm build
node dist/cli.js assemble examples/hello.vm -o /tmp/hello.mbc
node dist/cli.js disassemble /tmp/hello.mbc
node dist/cli.js link /tmp/hello.mbc --stack-capacity 1 -o /tmp/hello.mb
```

The installed command is `js2mb`. Native images remain very large; see
[VM usage and limits](docs/VM.md) before linking larger programs.
