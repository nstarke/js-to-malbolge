# VM bytecode, assembly tools, and the initial HeLL interpreter

`src/vm/` defines logical bytecode, a text assembler/disassembler, a versioned
binary format, a TypeScript execution oracle, and an initial native HeLL
interpreter. The native interpreter currently implements **push, putc, halt**.
The portable tools and reference interpreter support the complete ISA below.
Native memory layouts remain provisional; they are separate from the portable
bytecode ABI so future JavaScript compilation can target the same bytecode as
hand-written assembly.

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
EOF/newline output sentinel values: translation belongs to the future backend.

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
commands do not decompile arbitrary Malbolge source or compile JavaScript yet.
The future frontend should emit `BytecodeProgram` or this same portable binary
format, then use the existing linker.

## Native interpreter

`planHeLLVM(programOrBytes, options?)` creates a symbolic native image.
`assembleHeLLVM(programOrBytes, options?)` installs it using the unknown-width
bootstrap and returns legal Malbolge Unshackled source. Options include
`stackCapacity` (default 16, zero permitted) and `maxSourceCells` (default
500 million). The first backend accepts widths 10 through 20, zero locals,
and only push/putc/halt. Unsupported instructions fail at link time.

The interpreter is direct-threaded: the loader relocates each portable opcode
to the address of a shared handler. Fetch reads that dispatch target from the
current instruction record. Handlers advance PC through the record's next
pointer and return to fetch. Handler code depends on the stack configuration,
not on instruction count or literal values. No JavaScript/reference execution
is used to compute the program's output during linking.

Data frames live in banks 700 and 728. A proxy points to six fields spaced
94 cells apart, with independent return steering. Instruction fields contain
the dispatch target, operand, next record, output-validation tag, overflow
target, and numeric opcode ID. Literal records are immutable boxes; stack
frames hold references to them, predecessor/successor links, and capacity
guards. A capacity-one stack keeps its box pointer in a register. Larger
stacks use linked frames. Empty and overflow sentinels enforce bounds at runtime.

Handler and proxy addresses contain only 0/2 trits. Crazy with A=...111 can
read these pointers without changing them, avoiding a general word-copy
sequence. Arbitrary literals still use restoring reads. A cached read mask
and omission of redundant accumulator resets reduce the native code size.

`putc` enforces the reference VM's signed Unicode-scalar contract. The loader
tags each immutable literal as valid or invalid output data; putc checks that
tag at runtime. Future arithmetic handlers must compute tags for newly produced
values. This representation supports negative pushes and valid programs that
leave non-output values on the stack. There is no native getc or EOF translation
yet.

Successful halt and runtime faults have distinct native halt addresses in
`image.vm.faults`, keyed by `HELL_VM_FAULTS`: 0=success, 1=stack underflow,
2=stack overflow, 3=invalid output, 4=falling off the program. The halted C
register is one cell after the corresponding entry. These are explicit VM
faults, not Malbolge hangs or crashes. Inspect `image.vm.symbols`, `records`,
`stack`, and `empty` for PC and stack state. Resolve bank-relative addresses
using half the final value of `image.basisRegister` as the bank basis.

## Validation and current costs

Tests compare output, PC, and stack contents against `runVM`, check fault paths,
exercise Unicode and both stack layouts, verify instruction data is restored,
and confirm that changing an operand in memory changes execution while handler
code stays identical across programs. Full-source tests exercise growing
TypeScript interpreters and the unrestricted-width C interpreter; a separate
full-source test covers nested pushes with the linked stack.

The seven-instruction `push 65; putc; push 66; putc; push 10; putc; halt`
program uses **59,077,028 source cells** with capacity one and **24,330 native
code cells**. Capacity two uses **80,672,024 source cells** and **42,566 native
code cells** for that same program. Initialization and padding still dominate.
These are experimental images, not yet a practical general JS compiler.
When running all optional C-oracle integrations, use `pnpm test --maxWorkers=1`
to avoid having multiple large C processes compete for memory.

Next steps are native locals and stack operations, arithmetic and comparisons,
branches and calls, remaining I/O semantics, then the existing FizzBuzz fixture.
The portable assembler/disassembler already represents those instructions;
their native implementations can be added without giving the JS frontend a
second instruction format to target.
