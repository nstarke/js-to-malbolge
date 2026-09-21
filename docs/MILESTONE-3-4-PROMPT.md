# Prompt: milestones 3 and 4 of js-to-malbolge (VM under a known rotation width)

> Review update (2026-09-21): this is the original implementation brief, not
> a statement that all proposed mechanisms are verified. See `PLAN.md` for
> current progress, `BOOTSTRAP.md` for corrected constraints, and `VM.md` for
> the implemented TypeScript reference. The original computed-jump fixture
> below was impossible and has been replaced with a passing runtime-written
> pointer test. Small-constant loading, the reference VM, fixed-width wide
> initialization and arithmetic now exist. The latter use a separate register
> backend described in `FIXED-ARITHMETIC.md`; indexed access, reusable control
> flow, physical bytecode encoding, and the HeLL VM remain pending.

You are working in `/home/nick/Documents/git/js-to-malbolge`, a TypeScript
project (pnpm, vitest, Node 20) that compiles a JavaScript subset to Malbolge
Unshackled. Read `docs/PLAN.md` and `docs/BOOTSTRAP.md` first. Clean-room rule:
never copy code from existing Malbolge tooling (Lutter's HeLL/LMAO); derive
everything from the machine semantics. Run `pnpm test` before and after changes.

## What exists and works

- `src/malbolge/`: interpreters for standard Malbolge and Malbolge Unshackled
  (`runStandard`, `runUnshackled`, pluggable `RotationPolicy`: `fixedWidthPolicy(w)`,
  `minimalPolicy()`, `referencePolicy(seed)`), plus the trit-value library
  `trits.ts` (values are LSB-first strings, last char = repeating base trit).
  Verified against Lutter's C interpreter (`vendor/interp/unshackled`, fetched by
  `scripts/fetch-vendor.sh`; `vendor/interp/unshackled20` is the fixed-width-20 dialect).
- `src/hell/`: an assembler for the block/tape execution model.
  `ir.ts` defines `Program { blocks, tapes, entry }`, `Visit { block, operand, label? }`,
  operands `constant(v) | ref(label, off) | junk() | movd(label, off)`.
  `assemble.ts` places blocks at their legal residues, packs tape segments
  (floating restore visits, one-word `jmp` filler blocks created on demand,
  MovD splits), and emits source. `entry.ts` plans the entry code.
  Tests: `test/hell.test.ts` (cat loop, string printer via crazy-op chains) and
  `test/dj.test.ts` (cat loop through the double-j block) pass on both
  interpreters under several rotation policies.

## Execution model (all derived and verified; do not re-derive)

- Code = tiny restorable blocks `[entry][op][Jmp]`; the `op` cell alternates
  op/nop on each execution (F/J two-cycle), so every use of a block is paired
  with a later restore visit. The assembler inserts restores automatically.
- Control flow = the D register walking a "tape": a visit is `[ptr(block)][operand]`.
  The block's Jmp reads the next tape word as the next block pointer.
- Every source cell must be a legal instruction at its address, so static
  pointer values are <= 126. Consequently: blocks live in 33..126, and every
  MovD target addressed from static data must be pointer-addressable.
- The double-j block ("dj", fixed at cells 59..65: `[entry][j@60][gap x3][j@64][Jmp]`)
  implements MovD: visit `[59][P]` sets D := P+1, skips to P+4 and does D := [P+4].
  The gap cells are patched into permanent nops by the entry code (see `entry.ts`;
  D = C + 34 after the patch detours). Plain MovD to label T is
  written `visit("DJ", movd("T"))`: the assembler allocates a static pointer cell
  (<= 130) holding T-1. A *computed* MovD is `visit("DJ", ref("R", -3))` where `R`
  labels a P visit whose operand cell is a register: D := that cell's content.
  Restore visit of DJ consumes 6 words.
- Registers = operand cells of P visits inline in a tape; writing R means the
  flow passes `[81][R]` with the value in A (R := crazy(A, R)). Values travel
  between tapes only in A. There is no return-address mechanism except a
  register read by DJ, and DJ operands must be static, so any cell read by DJ
  is <= 130. Budget: roughly 45 free static cells for pointer cells and registers.
- Crazy-op chains from printable constants cannot cross value 81 (trit 4 of
  every constant is 0 or 1) and cannot produce ...222 patterns; rotation is the
  only way to build wide values. Under a known width w the plan is a
  straight-line *init code* phase (like the entry code: C and D walk in
  lockstep, `j` re-points D through static pointer cells, so `[*][j]` pairs
  rotate a static register repeatedly) that builds wide constants and writes
  them into pointer cells and wide tape words (two crazy writes per word:
  first make the cell's trits 1, then crazy with the value's S-preimage).
- Jump tables: a DJ on a register whose value is v lands D at v and the tape
  continues at v+1; values are < 243 (5 trits), so pads live in 128..243.
  Loop exits and data-dependent branches use this; each merge point back into
  a wide tape costs one static pointer cell.

## Original blocker (superseded by the review)

`test/dj.test.ts` "performs a computed MovD" fails to pack: the entry tape
`[P 39][P 74 'wr'][DJ ref('wr',-3)]` plus a segment fixed at 75 cannot be laid
out (trace with `assemble(prog, { trace })`: "deepest visit 1/3 ... nocand@rN"
means no free filler-block candidate for residue N in 33..126; most pointer
cells and fillers compete for the same region). Review proved that the
value-74 register is impossible under the source-address constraints, so
packer changes cannot make this exact fixture legal. Its replacement computes
237 from EOF and source value 123, then jumps to tape 238; it passes on both
TypeScript interpreters and both C oracles. General packing improvements are
still needed for larger programs.

## Milestone 3: arithmetic library (known width)

Add `Program.width` (start with w = 10 so standard Malbolge and
`fixedWidthPolicy(10)` agree; then w = 20 with `unshackled20` as oracle) and an
init-code generator `src/hell/init.ts` that takes directives
`{ cell, value }` (wide values into static pointer cells or wide tape words)
and masks (all-2s in the low w trits, ...111 patterns) and emits straight-line
code after the entry code. Then build, as reusable macro generators in
`src/hell/macros.ts` returning visit lists plus required static cells:
1. `load(A, smallConst)` and `store(R, value)` idioms (register reset to ...111
   via two crazies with A = ...111; store via crazy(A_base1, ...111)).
2. Read a trit of a register into a small value (three mask crazies:
   masks (1,2,1) at other positions, 2 at the observed position).
3. Increment and add on w-trit registers: digit-serial loop with a marker trit
   for termination and a jump-table lookup per digit (state = carry, digit a,
   digit b), result injected by rotation.
4. Subtract, compare (via subtraction and sign trit), indexed load/store
   (DJ on an address register lands on a `[81][cell][...]` frame at the data
   address; the data region is laid out with one such frame per cell).
Pass condition: each macro assembled into a test harness program, run on both
interpreters at the chosen width, results checked against a TypeScript oracle
over a range of values (read results by dumping the interpreter's memory at
the register addresses from `asm.symbols`).

## Milestone 4: the VM in HeLL

Define a minimal stack VM in `src/vm/`: bytecode as small digits (each cell
holds one of the 8 legal values at its address; the assembler chooses the
encoding), ~20 opcodes (push const, load/store local, add, sub, cmp, jump,
jump-if-zero, call/ret with an explicit stack, print char, read char, halt), a
TypeScript reference implementation, and an assembler from a textual bytecode
form. Then implement the VM loop in HeLL: PC register, fetch = DJ on PC lands
on the bytecode cell and dispatches on its value through a jump table, each
handler inline (no shared subroutines; returns are MovDs to the single loop-head
pointer cell). Pass condition: a hand-written fizzbuzz bytecode program runs
on the HeLL VM under the interpreter at the chosen width and prints the same
output as the TypeScript VM. Report program size and step count.

Work incrementally: one macro at a time, each with a passing test before the
next. Keep `docs/BOOTSTRAP.md` updated with any new constraint you discover.
