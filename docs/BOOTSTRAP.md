# Bootstrap notes: building wide values under an unknown rotation width

Everything here was derived from the reference interpreters' semantics and
verified with the interpreters in `src/malbolge/`. It records the constraints
that shape the assembler and the still-open problem of Malbolge Unshackled's
unknown rotation width.

## Hard facts about the machine

1. **Source cells are 33..126 and must decode to a real instruction at their
   address.** So a cell can initially hold only one of eight values, and a
   pointer stored in the source is at most 126. Consequently every code block
   and every MovD target that is addressed from source-initialised data lives
   below address 128. Anything wider must be computed at run time.
2. **Only F (70) and J (74) form a 2-cycle of the encryption table.** A cell
   that alternates instruction/nop exists for each instruction at exactly two
   address residues mod 94 (j: 60,64; *: 59,63; p: 82,86; <: 25,29; /: 43,47).
   The `<` block therefore only fits at 118 or 122, which crowds the top of the
   pointer-addressable region.
3. **A Jmp cell is never encrypted by its own execution** (the target cell is),
   so a two-cell block `[entry][Jmp]` is a permanent one-word tape filler at any
   address. The packer creates these on demand. Real nop padding needs the `o`
   instruction on an all-nop cycle, which exists at only 14 residues.
4. **A crazy-op chain from printable constants cannot cross 81.** Trit 4 and
   all higher trits of every printable constant are 0 or 1, so those trits of
   A just alternate; after an even number of steps they are back to 0, so A < 81
   whenever it has base 0. Values 81..126 are reachable only from values with
   trit 4 = 1. Rotation is the only way to move trits between positions.
5. **Base-2 values (...222 patterns) cannot be produced without input.**
   crazy(a, d) yields trit 2 only when a or d already has a 2 at that position,
   and the repeating base trit of every source value is 0. Only input (EOF gives
   ...222, newline ...221) introduces base 2. Base 1 (...111) is trivial: it is
   the crazy of any two base-0 values.
6. **D advances every step, so a cell written by `p` or `*` cannot be read as a
   pointer by the very next instruction.** In the block/tape scheme the block's
   Jmp reads the word after the operand, so a written word can never be read
   by `j`/`i`, unless a block skips cells: `[entry][j@60][nop][nop][nop][j@64][Jmp]`
   lands D at P+1 with the first j and reads P+4 with the second j. The word at
   P+4 can be written by a `p` visit whose pointer word sits at P+3, because the
   nops of the double-j block never read P+1..P+3. This is how run-time built
   pointers get used.
7. **Rotation width.** Unshackled starts with w in 10..15 and grows only on a
   MovD to an address wider than any before, to at least twice that width, with
   random slack. The spec allows any w >= max(10, 2 * maxDWidth). A program must
   therefore work for every w. Since rotation is needed for any value > 80 and
   for every wide pointer, the prologue must cope with unknown w.

## Sketch of the bootstrap (not yet implemented)

- A loop that runs exactly w times: rotate a cell holding 1 once per iteration
  and detect the 1 returning to trit 0. Observation: with a cell Z holding 0,
  `T = crazy(X, Z)` is ...111 with a single 0 at the marker's position, and
  `crazy(2, T)` is ...1110 when the marker is at trit 0 and ...1112 otherwise.
  These two base-1 values, used as MovD targets, land D at two different
  addresses in base-1 space; the prologue pre-writes pointers there (writing into
  base-1 space works because `crazy(base-1 A, rest value)` has base 0).
- Widen first: rotr(1) = 3^(w-1); a MovD there forces w to at least double.
  Repeat until w exceeds the widest address the program uses, then detect w.
  After that no MovD ever exceeds the maximum D width, so w is stable.
- Build a wide constant trit by trit inside an exactly-w loop: set trit 0 from
  a small constant, rotate; the first n iterations come from an unrolled tape
  (no loop) and the remaining w-n iterations from a loop that injects 0.
- Marker cells 3^k for k up to the constant width are built by the same loop
  (rotate in only the last w-k iterations).

Open questions: cost of the exactly-w loop in tape words below 128, and how to
deliver each built value to its destination (the double-j trick above).

## Decision for development order

The VM (milestones 3 and 4) is developed and tested under a known rotation
width first, using the interpreter's fixed-width policies and Lutter's
Unshackled-20 interpreter as an oracle. The width-agnostic bootstrap is a
separate deliverable layered underneath; the VM design keeps every rotation
width dependent constant in one place so the bootstrap can supply it later.
