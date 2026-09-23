# HeLLVM assembler and disassembler

These tools target the portable HeLLVM bytecode consumed by both `runVM` and
the native Malbolge linker. The [VM reference](VM.md) documents the 24 opcodes,
word semantics, binary format, and native execution limits. Disassembly reads
MBVM bytecode, not arbitrary Malbolge source.

## Command-line workflow

After `pnpm build`, use `node dist/cli.js` or the installed `js2mb` command:

```sh
node dist/cli.js assemble examples/assembler-demo.vm -o /tmp/demo.mbc --map /tmp/demo.map.json
node dist/cli.js disassemble /tmp/demo.mbc --symbols /tmp/demo.map.json --annotate --radix hex -o /tmp/demo.vm
node dist/cli.js assemble /tmp/demo.vm -o /tmp/demo-roundtrip.mbc
cmp /tmp/demo.mbc /tmp/demo-roundtrip.mbc
node dist/cli.js disassemble /tmp/demo.mbc --format json -o /tmp/demo.inspect.json
```

All commands accept `-` as input or output, and output defaults to stdout.
Errors go to stderr with exit status 1. `assemble --width N --locals N` supplies
metadata when source headers are absent; conflicting headers are errors. The
assembly default width is 10 trits (JS compilation defaults to 20).

`compile input.js --emit assembly` produces assembly accepted by these tools.
`link input.mbc -o output.mb` generates standalone Malbolge Unshackled source;
native output remains large. See [compression options and measurements](NATIVE-PERFORMANCE.md).

## Source syntax

Each line contains zero or more `name:` labels followed by at most one
instruction or directive. Mnemonics, directives, and symbols are case-sensitive.
Whitespace separates an opcode from its operand. `#`, `;`, and `//` begin
comments outside quoted literals. CRLF, CR, and LF line endings are accepted.

```asm
.width 20
.equ FIRST, 'A'
.local character

main: push FIRST + 1
      store character
.again:
      load character
      putc
      jump .done
.done:
      .println " — done 🙂"
      halt
.assert main.done > main.again, "labels are out of order"
```

Global symbol names begin with a letter or underscore, followed by letters,
digits, underscores, or dots. A name beginning with a dot is scoped to the
most recent global label: `.again` above becomes `main.again`. Local labels
require a preceding global label; different global scopes may reuse them.
Explicitly qualified names can reference a different scope. Labels, constants,
and named locals share a namespace, and duplicate definitions are errors.

Labels and branch operands are **logical instruction indices**, not byte
offsets or native addresses. Forward references are supported. `jump 0` and
`jump $ + 2` are valid; `$` denotes the instruction index at the expression's
source position. Branches and calls must target an existing instruction. A
label after the last instruction may be used in expressions or assertions,
but not as an executable target. String directives expand before labels are
resolved, so later indices account for all generated instructions.

## Directives

| Directive | Meaning |
| --- | --- |
| `.width expression` | Logical trit width, 10–1024; native linking supports 10–20. |
| `.locals expression` | Explicit local count, 0–1,000,000; must cover every referenced or declared local. |
| `.equ NAME, expression` | Define an exact integer constant; `=` may replace the comma. Forward references are supported; cycles are errors. |
| `.local NAME` | Allocate the lowest index not yet claimed by a named local. |
| `.local NAME, expression` | Give a local an explicit index; `=` also works. The expression must resolve at this point. Aliases are permitted. |
| `.print "text"` | Emit one `putci` instruction per Unicode scalar. |
| `.println "text"` | As above, followed by a newline. |
| `.assert expression[, "message"]` | Fail assembly if the expression is zero. Forward references are supported. |
| `.include "relative/path.vm"` | Include another source file at this point. |

Headers must precede labels and instructions and cannot be repeated. They may
refer to constants declared later. With no `.locals` header, the count is
inferred from declarations and `load`/`store` operands. Automatic `.local`
allocation tracks named declarations only; mixing raw numeric indices with
named locals requires explicit coordination.

The CLI resolves includes relative to the containing file; stdin uses the
current directory. Includes share the surrounding symbol namespace and label
scope. The API requires an explicit resolver and performs no filesystem I/O.
Nested includes retain their original filename and line numbers in diagnostics
and source maps. Include cycles and nesting beyond 32 levels are rejected.
`.include` must occupy its own line, apart from comments.

## Integer expressions and strings

Integer operands support arbitrary-precision decimal, hexadecimal (`0xff`),
binary (`0b101`), octal (`0o17`), and ternary (`0t102`) literals. Underscores may
separate digits. Single-quoted character literals such as `'A'` and `'\n'`
evaluate to Unicode scalar values. Arithmetic uses exact integers during
assembly; immediate words wrap into the centered range modulo `3^width` when
encoded or executed. Local indices and branch targets are range-checked instead
of wrapping.

Operator precedence, from highest to lowest:

| Operators | Meaning |
| --- | --- |
| `(...)` | Grouping |
| unary `+ - ~ !` | Identity, negation, bitwise complement, logical negation |
| `* / %` | Multiplication, division, remainder |
| `+ -` | Addition, subtraction |
| `<< >>` | Binary shifts |
| `< <= > >=` | Comparisons |
| `== !=` | Equality comparisons |
| `&` | Bitwise AND |
| `^` | Bitwise XOR |
| `\|` | Bitwise OR |

Binary operators associate left. Division truncates toward zero, remainder
keeps the dividend's sign, and comparisons/negation produce 0 or 1. Shift counts
must be 0–65,536; division by zero is an assembly error. These expressions are
parsed directly, never evaluated as JavaScript. Expression nesting and constant
dependency depth are each limited to 256.

String directives accept either quote style and escapes `\n`, `\r`, `\t`,
`\b`, `\f`, `\v`, `\0`, `\\`, `\'`, `\"`, `\xHH`, `\uHHHH`, and `\u{...}`.
There is no interpolation. Surrogate pairs are combined; unpaired surrogates
are rejected as output. Each string character must fit the signed word range
(use width 20 for arbitrary Unicode). Explicit `putci` instructions retain
ordinary VM wrapping and runtime Unicode validation.

## Listings, inspection, and maps

`disassemble` emits reassemblable source with `.width` and `.locals` headers.
It generates `L0000`-style names for branch destinations unless a symbol map is
supplied. `--radix decimal|hex|ternary` formats word immediates; indices and
metadata stay decimal. `--annotate` appends comments containing logical PCs,
file offsets, and exact encoded instruction bytes. All three radices and
annotated listings round-trip byte for byte.

`--format json` emits structural inspection with `format`, `version`, `width`,
`localCount`, `byteLength`, `wordBytes`, and an `instructions` array. Each record
contains `pc`, `offset`, `size`, numeric `opcode`, mnemonic `op`, and hex `bytes`.
Operands, branch `target` indices, and `label` names appear when applicable.
Word immediates are decimal **strings** to preserve precision in JSON; local
indices are numbers, and branch operands are label strings. JSON inspection
is not assembly input. `--radix` and `--annotate` require assembly output.

`assemble --map file.json` writes an optional `MBVM-map` version-1 sidecar with
the binary SHA-256 hash, all symbols and their kinds/values/source locations,
and one source location per logical instruction. String expansion maps each
emitted instruction to its directive. `disassemble --symbols file.json` verifies
the hash before restoring labels. If multiple labels share an index, the first
is displayed; all aliases remain in the map. Source comments, constant
expressions, local variable names, includes, and directive spelling are not
reconstructed. The portable bytecode format and opcode IDs remain unchanged.

## TypeScript API

```ts
import { vm } from "js-to-malbolge";

const {
  assembleBytecodeDetailed, encodeBytecode, disassembleBytecode, inspectBytecode,
} = vm;

const assembled = assembleBytecodeDetailed('.width 20\nmain: .println "Hi"\nhalt', {
  filename: "hello.vm",
});
const bytes = encodeBytecode(assembled.program);
const labels = new Map([...assembled.symbols]
  .filter(([, symbol]) => symbol.kind === "label")
  .map(([name, symbol]) => [Number(symbol.value), name] as const));
const listing = disassembleBytecode(bytes, { labels, annotate: true, radix: "hex" });
const inspection = inspectBytecode(bytes, { labels });
```

`assembleBytecode(source, options?)` returns only the program;
`assembleBytecodeDetailed` also returns `symbols: Map<string, AssemblySymbol>`
and `sourceMap: { pc, location }[]`. Options include `width`, `localCount`,
`filename`, `maxInstructions` (default 1,000,000), and
`resolveInclude(specifier, fromFilename) => { source, filename }`. Resolvers
should return stable, canonical filenames so cycle detection works reliably.
Assembly errors are `AssemblyError` instances with `filename`, `line`, and
`column` properties and a `filename:line:column: message` diagnostic. Locations
use one-based lines and UTF-16 columns.

Both disassembly APIs accept either a `BytecodeProgram` or encoded bytes and
validate the input. Custom label maps use instruction indices as keys, require
unique global names, and may include a label immediately after the last
instruction. Generated labels avoid collisions with supplied names.
