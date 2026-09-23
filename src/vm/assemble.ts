import { SIMPLE_OPS, validateBytecodeProgram, wordModulus, type BytecodeProgram, type Instruction, type SimpleOp } from "./isa.js";
import { atColumn, evaluateExpression, fail, parseExpression, readQuoted, stripComment, type AssemblyLocation, type Expression } from "./assembly-expression.js";
export { AssemblyError } from "./assembly-expression.js";
export type { AssemblyLocation } from "./assembly-expression.js";

export interface AssemblyOptions {
  width?: number;
  localCount?: number;
  filename?: string;
  /** API assembly performs no filesystem I/O; the CLI supplies this resolver. */
  resolveInclude?: (specifier: string, fromFilename: string) => { source: string; filename: string };
  maxInstructions?: number;
}
export interface AssemblySymbol { kind: "label" | "constant" | "local"; value: bigint; location: AssemblyLocation }
export interface AssemblyResult {
  program: BytecodeProgram;
  symbols: Map<string, AssemblySymbol>;
  sourceMap: { pc: number; location: AssemblyLocation }[];
}
interface Line { text: string; location: AssemblyLocation }
interface Definition { kind: AssemblySymbol["kind"]; value?: bigint; expression?: Expression; location: AssemblyLocation }
interface Pending { literalOutput?: boolean; op: Instruction["op"]; operand?: Expression; location: AssemblyLocation }

/** Labels and numeric branch operands name logical instruction indices. */
export function assembleBytecode(source: string, options: AssemblyOptions = {}): BytecodeProgram {
  return assembleBytecodeDetailed(source, options).program;
}

export function assembleBytecodeDetailed(source: string, options: AssemblyOptions = {}): AssemblyResult {
  const filename = options.filename ?? "<assembly>", maxInstructions = options.maxInstructions ?? 1_000_000;
  if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 0 || maxInstructions > 0xffffffff) throw new RangeError("invalid instruction budget");
  const lines: Line[] = [], active = new Set<string>();
  const expand = (text: string, file: string, depth: number) => {
    active.add(file);
    for (const [i, raw] of text.split(/\r\n?|\n/).entries()) {
      const location = { filename: file, line: i + 1, column: 1 };
      const uncommented = stripComment(raw, location), column = uncommented.search(/\S/);
      if (column < 0) continue;
      const line = { text: uncommented.trim(), location: atColumn(location, column) };
      const include = /^\.include\b/.exec(line.text);
      if (!include) { lines.push(line); continue; }
      const restAt = include[0].length + line.text.slice(include[0].length).search(/\S/);
      const quoted = readQuoted(line.text, restAt, line.location);
      if (line.text.slice(quoted.end).trim()) fail("unexpected text after .include", atColumn(line.location, quoted.end));
      if (!options.resolveInclude) fail(".include requires an include resolver", line.location);
      if (depth >= 32) fail("include depth exceeds 32", line.location);
      let included: { source: string; filename: string };
      try { included = options.resolveInclude(quoted.value, file); }
      catch (error) { return fail(`cannot include ${quoted.value}: ${error instanceof Error ? error.message : String(error)}`, line.location); }
      if (active.has(included.filename)) fail(`include cycle involving ${included.filename}`, line.location);
      expand(included.source, included.filename, depth + 1);
    }
    active.delete(file);
  };
  expand(source, filename, 0);
  const definitions = new Map<string, Definition>(), pending: Pending[] = [], assertions: { expression: Expression; message: string; location: AssemblyLocation }[] = [];
  let scope = "", requiredLocals = 0;
  const usedLocalIndices = new Set<number>();
  let widthHeader: { expression: Expression; location: AssemblyLocation } | undefined, localsHeader: typeof widthHeader;
  let sawLabel = false;
  const qualify = (name: string, location: AssemblyLocation) => {
    if (!name.startsWith(".")) return name;
    if (!scope) return fail("local symbol requires a preceding global label", location);
    return scope + name;
  };
  const define = (name: string, definition: Definition) => {
    const previous = definitions.get(name);
    if (previous) fail(`duplicate symbol ${name}; first defined at ${previous.location.filename}:${previous.location.line}`, definition.location);
    definitions.set(name, definition);
  };
  const evaluating = new Set<string>();
  const lookup = (name: string, location: AssemblyLocation): bigint => {
    const definition = definitions.get(name);
    if (!definition) return fail(`unknown symbol ${name}`, location);
    if (definition.value !== undefined) return definition.value;
    if (evaluating.has(name)) return fail(`cyclic constant ${name}`, definition.location);
    if (evaluating.size >= 256) return fail("constant dependency depth exceeds 256", definition.location);
    evaluating.add(name);
    const value = evaluateExpression(definition.expression!, (n) => lookup(n, definition.location), definition.location);
    evaluating.delete(name); definition.value = value;
    return value;
  };
  const evaluate = (expression: Expression, location: AssemblyLocation) => evaluateExpression(expression, (name) => lookup(name, location), location);
  const integer = (value: bigint, max: number, message: string, location: AssemblyLocation) => {
    if (value < 0n || value > BigInt(max)) fail(message, location);
    return Number(value);
  };
  const add = (inst: Pending) => {
    if (pending.length >= maxInstructions) fail("assembly exceeds the instruction budget", inst.location);
    pending.push(inst);
  };
  for (const line of lines) {
    let { text, location } = line;
    for (;;) {
      const label = /^([A-Za-z_][\w.]*|\.[A-Za-z_][\w.]*):/.exec(text);
      if (!label) break;
      const name = qualify(label[1], location);
      define(name, { kind: "label", value: BigInt(pending.length), location }); sawLabel = true;
      if (!label[1].startsWith(".")) scope = name;
      const consumed = label[0].length, space = text.slice(consumed).search(/\S/);
      if (space < 0) { text = ""; break; }
      text = text.slice(consumed + space); location = atColumn(location, consumed + space);
    }
    if (!text) continue;
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)!;
    const op = match[1], operand = match[2] ?? "", operandLocation = atColumn(location, text.length - operand.length);
    const expression = (value = operand, at = operandLocation) => parseExpression(value, at, (name) => qualify(name, at), pending.length);
    if (op === ".width" || op === ".locals") {
      if (pending.length || sawLabel) fail("invalid header directive after code or labels", location);
      if (op === ".width" ? widthHeader : localsHeader) fail(`duplicate ${op}`, location);
      const header = { expression: expression(), location: operandLocation };
      if (op === ".width") widthHeader = header; else localsHeader = header;
      continue;
    }
    if (op === ".equ" || op === ".local") {
      const declaration = /^([A-Za-z_][\w.]*|\.[A-Za-z_][\w.]*)(?:\s*[,=]\s*([\s\S]+))?$/.exec(operand);
      if (!declaration || op === ".equ" && !declaration[2]) fail(`${op} requires a name${op === ".equ" ? " and an expression" : " with an optional index"}`, operandLocation);
      const name = qualify(declaration[1], operandLocation);
      if (op === ".equ") define(name, { kind: "constant", expression: expression(declaration[2], atColumn(operandLocation, operand.lastIndexOf(declaration[2]))), location: operandLocation });
      else {
        let index = 0;
        if (declaration[2]) index = integer(evaluate(expression(declaration[2]), operandLocation), 999_999, "invalid local index", operandLocation);
        else while (usedLocalIndices.has(index)) index++;
        if (index >= 1_000_000) fail("invalid local index", operandLocation);
        define(name, { kind: "local", value: BigInt(index), location: operandLocation });
        usedLocalIndices.add(index); requiredLocals = Math.max(requiredLocals, index + 1);
      }
      continue;
    }
    if (op === ".print" || op === ".println") {
      const quoted = readQuoted(operand, 0, operandLocation);
      if (operand.slice(quoted.end).trim()) fail(`${op} takes one string`, operandLocation);
      for (const ch of quoted.value + (op === ".println" ? "\n" : "")) {
        const value = ch.codePointAt(0)!;
        if (value >= 0xd800 && value <= 0xdfff) fail("output requires Unicode scalar values", operandLocation);
        add({ literalOutput: true, op: "putci", operand: { kind: "number", value: BigInt(value) }, location });
      }
      continue;
    }
    if (op === ".assert") {
      // Commas cannot occur in integer expressions except inside a character.
      let split = -1;
      for (let i = 0; i < operand.length; i++) {
        if (operand[i] === "'") { i = readQuoted(operand, i, operandLocation).end - 1; continue; }
        if (operand[i] === ",") { split = i; break; }
      }
      let message = "assembly assertion failed";
      if (split >= 0) {
        const tail = operand.slice(split + 1).trim(), quoted = readQuoted(tail, 0, operandLocation);
        if (tail.slice(quoted.end).trim()) fail("unexpected assertion text", operandLocation);
        message = quoted.value;
      }
      assertions.push({ expression: expression(split < 0 ? operand : operand.slice(0, split)), message, location }); continue;
    }
    if ((SIMPLE_OPS as readonly string[]).includes(op)) {
      if (operand) fail(`${op} takes no operand`, operandLocation);
      add({ op: op as SimpleOp, location }); continue;
    }
    if (!["push", "modi", "divi", "putci", "load", "store", "jump", "jz", "call"].includes(op)) fail(`unknown opcode or directive ${op}`, location);
    add({ op: op as Instruction["op"], operand: expression(), location });
  }
  const root = { filename, line: 1, column: 1 };
  const declaredWidth = widthHeader ? integer(evaluate(widthHeader.expression, widthHeader.location), 1024, "invalid width", widthHeader.location) : undefined;
  const declaredLocals = localsHeader ? integer(evaluate(localsHeader.expression, localsHeader.location), 1_000_000, "invalid localCount", localsHeader.location) : undefined;
  if (declaredWidth !== undefined && options.width !== undefined && declaredWidth !== options.width) fail(".width conflicts with options.width", widthHeader!.location);
  if (declaredLocals !== undefined && options.localCount !== undefined && declaredLocals !== options.localCount) fail(".locals conflicts with options.localCount", localsHeader!.location);
  const width = declaredWidth ?? options.width ?? 10;
  let modulus: bigint;
  try { modulus = wordModulus(width); } catch (error) { return fail((error as Error).message, widthHeader?.location ?? root); }
  const instructions = pending.map(({ op, operand, location, literalOutput }): Instruction => {
    if (!operand) return { op: op as SimpleOp };
    const value = evaluate(operand, location);
    if (literalOutput && value > (modulus - 1n) / 2n) fail("string character requires a larger width", location);
    if (op === "push" || op === "modi" || op === "divi" || op === "putci") return { op, value };
    if (op === "load" || op === "store") {
      const index = integer(value, 999_999, "invalid local index", location);
      requiredLocals = Math.max(requiredLocals, index + 1); return { op, index };
    }
    const target = integer(value, pending.length - 1, "invalid or empty jump target", location);
    return { op: op as "jump" | "jz" | "call", target };
  });
  for (const assertion of assertions) if (!evaluate(assertion.expression, assertion.location)) fail(assertion.message, assertion.location);
  const symbols = new Map<string, AssemblySymbol>();
  for (const [name, definition] of definitions) symbols.set(name, { kind: definition.kind, value: lookup(name, definition.location), location: definition.location });
  const localCount = declaredLocals ?? options.localCount ?? requiredLocals;
  if (!Number.isSafeInteger(localCount) || localCount < requiredLocals || localCount > 1_000_000 || localCount < 0) fail("localCount must cover all referenced locals and be at most 1000000", localsHeader?.location ?? root);
  const program = { width, localCount, instructions }; validateBytecodeProgram(program);
  return { program, symbols, sourceMap: pending.map((inst, pc) => ({ pc, location: inst.location })) };
}
