# JavaScript compilation

`compileJS(source, { width = 20, filename = "<input>", optimize = true, heapCapacity = 64 } = {})` parses JavaScript
with Acorn, checks the supported subset, lowers it to symbolic instructions,
and returns the same `BytecodeProgram` used by the assembler and native linker.
Compilation never runs the source program to discover its output. It folds
constant expressions using the selected modular word width, propagates local
constants within basic blocks, removes unreachable code and unused stores, and
emits literal output when formatting can be resolved statically. Unsupported
syntax is still checked before optimization. Set `optimize: false` or use
`--no-optimize` to inspect the unsimplified lowering.

```ts
import { compileJS, vm } from "./src/index.js";

const program = compileJS("for (let i = 0; i < 3; i++) console.log(i);");
console.log(vm.runVM(program).output); // 0\n1\n2\n
const bytes = vm.encodeBytecode(program);
const assembly = vm.disassembleBytecode(bytes);
```

After `pnpm build`, the CLI can emit portable bytecode, canonical assembly, or
Malbolge source:

```sh
node dist/cli.js compile examples/fizzbuzz.js --emit bytecode -o /tmp/fizzbuzz.mbc
node dist/cli.js compile examples/fizzbuzz.js --emit assembly -o /tmp/fizzbuzz.vm
node dist/cli.js compile examples/hello.js --stack-capacity 1 -o /tmp/hello.mb
vendor/interp/unshackled /tmp/hello.mb
```

`compile` defaults to `--emit malbolge` and `--width 20`. It accepts stdin as
`-`, `-o` for an output file, and the linker's `--stack-capacity`,
`--return-stack-capacity`, and `--max-source-cells` options when emitting
Malbolge. `--optimize size` selects compact arithmetic and shrinks default stack
capacities only where a bound can be proved; explicit capacities are honored.
`--installer loop` enables the native padding decoder for large images, trading
startup work for smaller source. `--stats report.json` writes a source-size
breakdown. These native options also work with `link`. See
[compression measurements](NATIVE-PERFORMANCE.md) for the tradeoffs.

The native backend implements every opcode emitted by the frontend.
Images remain very large and may exceed the source budget; see `VM.md` for
measurements and validation limits. Both native stacks default to 16 words.
Recursive calls and decimal formatting may need larger capacities.

## Supported language

| Construct | Supported behavior |
| --- | --- |
| Values | Safe integer number literals, booleans, object literals, and array literals. Strings and expression-free template literals as `console.log` arguments. |
| Aggregates | Fixed-shape objects with dot or literal-string property access; fixed-length homogeneous arrays with integer indexing and read-only `.length`. Nested values, aliases, mutation, and reference identity. |
| Bindings | Initialized `let` and `const`, lexical block shadowing, multiple declarators, constant assignment checks, use-before-initialization diagnostics. |
| Expressions | `+ - * / %`, comparisons, scalar loose/strict equality, unary `+ - !`, assignments and arithmetic compound assignments, prefix/postfix `++ --`, sequence expressions, ternaries. |
| Short-circuiting | `&&` and `||` preserve operand values and evaluate the right side only when required. Both operands must have the same type. Objects and arrays are truthy. |
| Control flow | `if`/`else`, `while`, `do`/`while`, `for`, unlabeled `break`/`continue`. |
| Functions | Top-level declarations, forward calls, scalar or aggregate parameters/results, void procedures, nested calls, recursion and mutual recursion. Exact argument counts. |
| Output | `console.log` with spaces between arguments and a trailing newline. Integers print in decimal and booleans as `true`/`false`. |

Arguments evaluate left to right, and all `console.log` arguments evaluate
before that call emits output. Assignments and updates preserve their JS result
values. Strict equality distinguishes integers from booleans; arithmetic and
loose scalar equality convert booleans to 0/1. Builtins respect lexical shadowing.

Bindings, function parameters/results, and both arms of conditional expressions
must retain one type, including object shape and array element type. Functions
may refer to their own parameters and locals, other top-level functions, and builtins. Outer variables must be passed
explicitly as arguments. Functions returning values must return a value on every
statically checked path; void functions may fall through or use bare `return`.
This check conservatively treats loops as potentially terminating.

This is an **integer subset**, not a full ECMAScript implementation. Arithmetic
wraps in the centered signed range modulo `3^width`; default width 20 covers
-1,743,392,200 through 1,743,392,200. Division truncates toward zero and remainder
has the dividend's sign. Zero has no negative sign. Division by zero is a VM
fault. `Math.trunc` is accepted as an integer conversion, allowing expressions
such as `Math.trunc(a / b)` in fixtures compared with Node. Floating-point
intermediate results, NaN, Infinity, and signed zero are outside the subset.

Dynamic object properties, array resizing/methods, heterogeneous or sparse arrays,
mutable strings, string concatenation/interpolation, closures,
function expressions, arrow functions, `var`, destructuring, default/rest/spread
parameters, optional chaining, bitwise operations, classes, modules, exceptions,
async code, and `console.log` formatting substitutions remain unsupported.
There is no `undefined` or `null` VM value, so declarations need initializers
and void results cannot be stored in bindings, fields, or array elements. Unicode
output must fit the selected signed word width and contain valid scalar values.

Unsupported constructs fail with `JSCompileError` containing filename, line,
and column. The frontend checks unreachable source as well, and does not silently
ignore unsupported syntax or dynamically fall back to host execution.

## Objects and arrays

```js
function move(point, dx) {
  point.x += dx;
  return point;
}
const points = [{x: 1, y: 2}, {y: 4, x: 3}];
const alias = move(points[0], 5);
console.log(points[0].x, points.length, alias === points[0]); // 6 2 true
```

Object literals accept plain data properties, quoted keys, and shorthand.
Access uses `point.x` or `point["x"]`; property names must be known at compile
time. Fields can have different types, but each field retains its type and
properties cannot be added or deleted. Objects with identical property names
and field types share a structural type, regardless of literal key order. Property
access requires an inferred aggregate shape, usually supplied by an initializer
or function call site.
Getters, setters, methods, computed literal keys, duplicate keys, prototypes,
and `__proto__` are unsupported.

Array elements share one type, which can itself be an object or array type.
Different array lengths can flow through the same binding or function parameter.
Empty literals are allowed and infer an element type from other uses. Indexing
requires an integer expression; string indices are unsupported. `.length` and
`["length"]` return the immutable length. Array holes, spread, `new Array`,
`push`/`pop`, and out-of-range writes are unsupported. Out-of-range reads and
writes fault at runtime, including negative indices; there is no `undefined`.

Assignments and calls copy references, so aliases observe mutations. `const`
prevents rebinding but permits field/element writes. Each executed literal
creates a fresh allocation, including inside loops and recursive functions.
Equality between aggregates compares identity. Strict equality with a scalar
is false; loose equality between an aggregate and a scalar is rejected because
object-to-primitive coercion is outside this subset. Aggregate values cannot be
printed directly; pass their scalar fields or elements to `console.log`.

The heap is a bounded arena with no garbage collection. Set `heapCapacity` in
`compileJS` or `--heap-capacity N` in the CLI (default 64). Each allocation uses
one header word plus one word per property or element; nested literals allocate
separately, and even an empty literal consumes one word. Capacity counts all
allocations over the entire execution, including values that become unreachable.
A literal larger than the heap fails at compile time. Exhaustion and invalid
array indices intentionally trigger the existing division-by-zero VM fault
(native fault 7); they do not continue with wrapped or invalid addresses.
Capacity must be a positive integer at most 65536 and below the selected signed
word maximum. Scalar-only programs emit no heap helpers.

The heap lowers to ordinary local cells and shared bytecode routines, so binary
and assembly round trips and native Malbolge execution use the same operations.
Indirect access uses a balanced dispatch tree. Increasing capacity increases
bytecode and native image size even if many cells go unused. Heap helpers also
use the return stack (up to two extra entries during indexing); account for
that when setting native stack capacities.

## Calls and runtime helpers

The VM has shared local cells and a separate return stack. The compiler gives
each function private local slots, including compiler temporaries. On entry it
collects arguments into scratch slots, saves the current activation's locals on
the data stack, and installs the new parameters. Each return restores the saved
locals while leaving the result on top. Saving after argument evaluation
preserves mutations in recursive arguments. Void calls use an internal dummy
word which is discarded by expression statements.

Integer formatting uses one shared recursive decimal-printing routine, rather
than emitting a decimal converter at every call site. Boolean formatting and
literal strings use immediate character output (`putci`). Literal divisors use
`divi`/`modi`, including the shared decimal formatter's division and remainder
by ten. These transformations do not evaluate user programs while compiling. Symbolic labels are resolved
only after frame and formatting operations expand into ordinary bytecode.

Tests compare output against Node for FizzBuzz, scopes, short-circuiting,
evaluation order, updates, loops, recursion, mutual recursion, Unicode, and
aggregate aliasing, nested mutation, layouts, and bounds. Aggregate programs
also run through the native register microcode model.
They also check binary/assembly round trips and clean data/return stacks. The
full-source native integration compiles `console.log("AB")`, installs the VM
from legal source, and runs under growing-width policies and the external C
interpreter. A second full-source integration compiles `const result = 19 + 23`
with frontend optimization disabled to exercise native addition,
and checks its computed local value in the byte-backed TypeScript machine.

Compiled FizzBuzz also runs from complete Malbolge source. The reproducible
benchmark and its costs are documented in `NATIVE-PERFORMANCE.md`; widths and
rotation policies beyond the measured configuration remain separate checks.
