# VM bytecode, assembly tools, and the HeLL interpreter

`src/vm/` defines logical bytecode, a text assembler/disassembler, a versioned
binary format, a TypeScript execution oracle, and a native HeLL interpreter.
Both interpreters implement **all 21 opcodes** below.
Native memory layouts remain provisional; they are separate from the portable
bytecode ABI. The JavaScript frontend targets the same bytecode as hand-written
assembly; see `JAVASCRIPT.md` for its supported subset.

Words are centered signed integers modulo `3^width`. Width defaults to 10;
10 and 20 are the development targets (the reference accepts 10..1024).
At width 10 the range is -29524..29524. Pushes and arithmetic wrap into that
range. Signed division truncates toward zero and remainder has the dividend's
sign, as with JavaScript integer arithmetic. Comparisons yield 0 or 1.

| Instructions | Behavior |
| --- | --- |
| `push integer` | Push a decimal integer, normalized to the word width. |
| `load index`, `store index` | Read a local or pop into it. Locals start at zero and are shared across calls. |
| `add`, `sub`, `mul`, `div`, `mod`, `eq`, `lt`, `le` | Pop right operand, then left; push the result. Division by zero is an error. |
| `dup`, `drop`, `swap` | Duplicate the top word, discard it, or exchange the top two. |
| `jump label`, `jz label` | Jump unconditionally, or pop a condition and jump if zero. |
| `call label`, `ret` | Push the next instruction index onto a separate return stack and jump, or pop that return address. Arguments/results use the data stack. |
| `getc`, `putc` | Read one Unicode code point (EOF = -1), or pop and print one. Input must fit the signed word range; output must be a Unicode scalar value. |
| `halt` | Stop successfully. Falling off the instruction array is an error. |

Labels (`name:`) are case-sensitive instruction indices. Each line contains
at most one label and one instruction; `#` starts a comment. Forward labels
are supported. Local count is inferred or supplied explicitly. The assembler
rejects invalid operand counts, unknown labels/opcodes, duplicate labels,
and invalid indices. The execution oracle also validates hand-built programs.

Optional `.width N` and `.locals N` directives appear before any labels or
instructions. They preserve program metadata in disassembly; conflicting API
options and duplicate directives are errors. `disassembleBytecode` emits
canonical assembly with generated `L0000`-style labels. Original comments and
label spelling are not retained. Assembling that listing reproduces the binary
bytecode exactly, including normalized immediates and the declared local count.

`runVM` defaults to one million executed instructions, counts `halt` as one
instruction, and returns output, step count, PC, locals, and both stacks.
Exhausting the limit returns `step-limit`; malformed execution throws an error
with the instruction index. The reference does not use the Malbolge machine's
EOF/newline sentinel values: the native backend translates these at its I/O boundary.

`examples/fizzbuzz.vm` exercises loops, divisibility tests, shared locals,
conditional jumps, and recursive decimal printing. It prints fizzbuzz from
1 through 100 with a trailing newline: 73 logical instructions, 4,251 reference
steps, and 413 output bytes at both development widths. Tests compare its
output to an independent JavaScript implementation and also check signed
overflow, operand order, nested calls, Unicode/EOF, and invalid programs.

## Portable binary format, version 1

`encodeBytecode(program)` returns a `Uint8Array`; `decodeBytecode(bytes)` returns
a validated `BytecodeProgram`. All multi-byte integers are little-endian.

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 4 | ASCII `MBVM` |
| 4 | 1 | Version, currently 1 |
| 5 | 1 | Flags, currently zero |
| 6 | 2 | Logical trit width |
| 8 | 4 | Local count |
| 12 | 4 | Logical instruction count |
| 16 | variable | Instruction stream |

Each instruction begins with a one-byte opcode. IDs are explicit constants in
`OPCODE_IDS`: halt=0, push=1, putc=2, getc=3, load=4, store=5, add=6, sub=7,
mul=8, div=9, mod=10, eq=11, lt=12, le=13, dup=14, drop=15, swap=16, jump=17,
jz=18, call=19, ret=20. Existing IDs must not be renumbered or reused.

`push` carries the unsigned residue modulo `3^width`, in the minimum whole
number of bytes needed to hold any word of that width. Decoding converts it
back to the centered signed representation. Load/store operands and branch/call
targets use unsigned 32-bit integers; targets remain logical instruction
indices. Other instructions have no operand. The decoder rejects unknown
opcodes, unsupported versions/flags, truncated or trailing data, noncanonical
word residues, and invalid local/branch indices.

## CLI

After `pnpm build`:

```sh
node dist/cli.js assemble examples/hello.vm -o /tmp/hello.mbc
node dist/cli.js disassemble /tmp/hello.mbc -o /tmp/hello.vm
node dist/cli.js link /tmp/hello.mbc --stack-capacity 1 -o /tmp/hello.mb
vendor/interp/unshackled /tmp/hello.mb
```

The installed binary is named `js2mb`. All three commands accept `-` for stdin
and default to stdout when `-o` is absent. Assembly is VM assembly; these
commands do not decompile arbitrary Malbolge source. `js2mb compile` now compiles
JavaScript to `BytecodeProgram`, this portable binary format, canonical assembly,
or native source through the existing linker; see `JAVASCRIPT.md`.

## Native interpreter

`planHeLLVM(programOrBytes, options?)` creates a symbolic native image.
`assembleHeLLVM(programOrBytes, options?)` installs it using the unknown-width
bootstrap and returns legal Malbolge Unshackled source. Native widths are 10
through 20. Options include `stackCapacity` and `returnStackCapacity` (both
default to 16; zero permitted), and `maxSourceCells` (default 500 million).
The CLI exposes these as `--stack-capacity`, `--return-stack-capacity`, and
`--max-source-cells`. Recursive functions save their locals on the data stack,
so both capacities may need increasing.

The loader relocates portable instructions into data records. Shared handlers
fetch operands and dispatch at runtime; compilation does not execute the
program or precompute its output. Only needed opcode handlers and their
arithmetic dependencies are included. The portable ABI is unchanged.

`image.vm.kind` identifies two layouts:

- `literal`: programs containing only push/putc/halt and no locals use immutable
  literal boxes. Stack frames hold pointers to these boxes; capacity one keeps
  its pointer in a register. Literal output validity is tagged during linking
  and checked at runtime.
- `microcode`: the full interpreter stores numeric words in data-stack frames
  and local cells, and instruction pointers in a separate return stack. Shared
  register primitives execute microinstructions stored as data. Logical rotation
  uses one shared routine. Addition, subtraction, and unsigned comparison loop
  over word digits instead of duplicating their circuits for each iteration.
  Multiplication uses ternary shift/add; signed division and remainder use
  ternary long division. Output validation checks computed values at runtime.

Data frames live in banks 700 and 728, with fields spaced 94 cells apart and
independent return steering. General values use restoring reads; pointers with
only 0/2 trits use a shorter nondestructive read where possible. The installer
caches common masks and prepared values, including bank-relative pointers,
and uses nearby anchors to reduce padding.

Successful halt and runtime faults have distinct native halt addresses in
`image.vm.faults`, keyed by `HELL_VM_FAULTS`:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 / 2 | Data stack underflow / overflow |
| 3 | Invalid Unicode output |
| 4 | Falling off the instruction array |
| 5 / 6 | Return stack underflow / overflow |
| 7 | Division by zero |
| 8 | Input outside the signed word range |

The halted C register is one cell after the corresponding entry. Inspect
`image.vm.symbols`, `records`, and `stack` for runtime state; the microcode plan
also exposes `locals` and `returnStack`. Resolve bank-relative addresses using
half the final value of `image.basisRegister` as the bank basis.

## Validation and current costs

Frontend tests compare supported JS programs with Node. Bytecode tests check
codec/assembly round trips and reference execution. An independent register
microcode model checks all opcode routines, arithmetic boundaries at widths 10
and 20, faults, and compiled control flow, functions, and decimal formatting.
Native primitive tests exercise restoring reads/writes, growing-width logical
rotations, branching, and input sentinel translation. A separate native runtime
test fetches bytecode and computes addition in the Unshackled machine.

Full-source tests install and execute compiled JS literal output under growing
TypeScript policies and the unrestricted-width C oracle, and compiled JS
arithmetic in the byte-backed TypeScript machine. These start from legal source
without injecting memory. Larger C runs exceed available memory because that
interpreter allocates hundreds of bytes per source cell; it is not used as a
full-source oracle for the large arithmetic image. Full native FizzBuzz execution
and performance remain unverified.

| Program | Stack capacity | Source cells | Native code cells |
| --- | --- | --- | --- |
| Seven-instruction `AB\n` output | 1 | 43,877,510 | 24,330 |
| Same output, linked stack | 2 | 54,294,872 | 42,566 |
| JS `console.log(19 + 23)`, width 20 | 16 | 287,471,930 | 281,620 |

The small output images previously occupied 59,077,028 and 80,672,024 cells:
installation improvements reduce them by about 26% and 33%. The numeric example
uses 467 microinstructions and previously exceeded the 500-million-cell source
budget before sharing rotations, looping arithmetic, and caching masks.
Initialization, padding, and runtime cost remain substantial. Native images
are experimental and larger programs can still exceed the source budget.

Run `pnpm test --maxWorkers=1` to avoid concurrent large integrations competing
for memory. Next work includes full-source FizzBuzz benchmarking, further source
and runtime reductions, and frontend arrays and general strings.
