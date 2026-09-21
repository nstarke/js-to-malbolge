# Reference VM and provisional bytecode ABI

`src/vm/` defines logical bytecode, a text assembler, and a TypeScript execution
oracle. There is no physical Malbolge encoding or HeLL VM yet. Changing this
ABI as the runtime is implemented is expected.

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
