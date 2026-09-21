/**
 * Program model for the block/tape execution scheme.
 *
 * Code consists of small blocks that each execute one instruction and then
 * jump. The jump reads the next tape word as its target, so control flow is
 * expressed by the sequence of tape words the D register walks through.
 *
 * A "visit" is a pair of tape words: a pointer to a block (block address - 1)
 * followed by the word the block's instruction operates on. Visiting a
 * restorable block flips it into its nop phase, so every use is followed by a
 * restore visit (for MovD, the restore visit is the first visit of the target
 * segment). The assembler inserts those automatically.
 */

/**
 * Block kinds. "dj" is the double-j block [entry][j][nop][nop][nop][j][Jmp] at
 * address 59: a visit [ptr][P] lands D at P+1, skips to P+4 and sets
 * D := [P+4]. The three gap cells are patched into permanent nops by the
 * program's entry code. "jmp" is a two-cell block [entry][Jmp] with no instruction:
 * visiting it consumes exactly one tape word (its pointer), so it serves as a
 * one-word filler at any address. "nop" is [entry][o][Jmp] and needs a
 * permanent-nop residue. "nop2" has two nop cells (rarely placeable).
 */
export type BlockOp = "j" | "dj" | "*" | "p" | "<" | "/" | "v" | "nop" | "nop2" | "jmp";

export interface CodeBlock {
  label: string;
  op: BlockOp;
  /** Pin a block when a macro depends on its pointer's legal tape residues. */
  address?: number;
}

export type WordSpec =
  | { kind: "const"; value: number } // must be 33..126 and legal at its address
  | { kind: "ref"; label: string; offset: number } // address of a label plus offset
  | { kind: "junk" } // never read; any legal value
  /**
   * MovD to a label (plus offset) through the double-j block: the assembler
   * allocates a static pointer cell holding the target address and the
   * operand word points at it. Only valid as the operand of a "dj" visit.
   */
  | { kind: "movd"; label: string; offset: number };

export interface Visit {
  block: string;
  operand: WordSpec;
  /** Optional label for the address of this visit's pointer word. */
  label?: string;
}

export interface TapeSegment {
  label: string;
  visits: Visit[];
  /** True if entered by a MovD (needs a leading restore visit for the j block). */
  movdTarget: boolean;
  /** Force the first word to this address (for computed-jump landing sites). */
  fixedStart?: number;
}

export interface Program {
  blocks: CodeBlock[];
  tapes: TapeSegment[];
  /** Label of the tape segment execution starts in. */
  entry: string;
}

export const ref = (label: string, offset = 0): WordSpec => ({ kind: "ref", label, offset });
export const movd = (label: string, offset = -1): WordSpec => ({ kind: "movd", label, offset });
export const constant = (value: number): WordSpec => ({ kind: "const", value });
export const junk = (): WordSpec => ({ kind: "junk" });
