import { SIMPLE_OPS, wordModulus, type BytecodeProgram, type Instruction, type SimpleOp } from "./isa.js";

/** Labels name logical instruction indices, not yet Malbolge memory addresses. */
export function assembleBytecode(source: string, options: { width?: number; localCount?: number } = {}): BytecodeProgram {
  let declaredWidth: number | undefined, declaredLocals: number | undefined;
  const labels = new Map<string, number>();
  const lines: { text: string; line: number }[] = [];
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    let text = raw.replace(/#.*/, "").trim();
    if (text.startsWith(".")) {
      const directive = /^\.(width|locals)\s+(\d+)$/.exec(text);
      if (!directive || lines.length || labels.size) throw new SyntaxError(`line ${i + 1}: invalid header directive`);
      const value = Number(directive[2]);
      if (!Number.isSafeInteger(value)) throw new RangeError(`line ${i + 1}: invalid directive value`);
      if (directive[1] === "width") {
        if (declaredWidth !== undefined) throw new SyntaxError(`line ${i + 1}: duplicate .width`);
        declaredWidth = value;
      } else {
        if (declaredLocals !== undefined) throw new SyntaxError(`line ${i + 1}: duplicate .locals`);
        declaredLocals = value;
      }
      continue;
    }
    const label = /^([A-Za-z_][\w]*):/.exec(text);
    if (label) {
      if (labels.has(label[1])) throw new SyntaxError(`line ${i + 1}: duplicate label ${label[1]}`);
      labels.set(label[1], lines.length);
      text = text.slice(label[0].length).trim();
    }
    if (text) lines.push({ text, line: i + 1 });
  }
  if (declaredWidth !== undefined && options.width !== undefined && declaredWidth !== options.width) throw new RangeError(".width conflicts with options.width");
  if (declaredLocals !== undefined && options.localCount !== undefined && declaredLocals !== options.localCount) throw new RangeError(".locals conflicts with options.localCount");
  const width = declaredWidth ?? options.width ?? 10;
  wordModulus(width);
  let requiredLocals = 0;
  const instructions = lines.map(({ text, line }): Instruction => {
    const [op, operand, ...extra] = text.split(/\s+/);
    const fail = (message: string): never => { throw new SyntaxError(`line ${line}: ${message}`); };
    if ((SIMPLE_OPS as readonly string[]).includes(op)) {
      if (operand !== undefined) fail(`${op} takes no operand`);
      return { op: op as SimpleOp };
    }
    if (!["push", "load", "store", "jump", "jz", "call"].includes(op)) fail(`unknown opcode ${op}`);
    if (operand === undefined || extra.length) fail(`${op} takes one operand`);
    if (op === "push") {
      if (!/^-?\d+$/.test(operand)) fail("push requires a decimal integer");
      return { op, value: BigInt(operand) };
    }
    if (op === "load" || op === "store") {
      const index = /^\d+$/.test(operand) ? Number(operand) : NaN;
      if (!Number.isSafeInteger(index) || index >= 1_000_000) fail("invalid local index");
      requiredLocals = Math.max(requiredLocals, index + 1);
      return { op, index };
    }
    const target = labels.get(operand);
    if (target === undefined || target >= lines.length) fail(`unknown or empty target ${operand}`);
    return { op: op as "jump" | "jz" | "call", target: target! };
  });
  const localCount = declaredLocals ?? options.localCount ?? requiredLocals;
  if (!Number.isSafeInteger(localCount) || localCount < requiredLocals || localCount > 1_000_000) {
    throw new RangeError("localCount must cover all referenced locals and be at most 1000000");
  }
  return { instructions, width, localCount };
}
