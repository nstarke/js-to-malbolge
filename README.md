# js-to-malbolge

Compile a subset of JavaScript to Malbolge Unshackled. Work in progress; see
`docs/PLAN.md` for the design and milestones.

```sh
pnpm install
pnpm fetch-vendor   # optional: reference interpreters and fixtures for tests
pnpm test
```

Current components: interpreters, a block/tape HeLL assembler, a fixed-width
register backend with wide initialization, arithmetic, and indexed memory;
reusable register loops linked to an input-free bootstrap with unknown rotation
width, and a reference stack VM with textual bytecode. The HeLL VM backend,
JavaScript compilation, and CLI are not implemented yet. See [milestone status](docs/PLAN.md),
[arithmetic usage](docs/FIXED-ARITHMETIC.md),
[memory and control-flow APIs](docs/MEMORY-CONTROL.md), and the
[reference VM ABI](docs/VM.md). A hand-written fixture lives in
[`examples/fizzbuzz.vm`](examples/fizzbuzz.vm).
