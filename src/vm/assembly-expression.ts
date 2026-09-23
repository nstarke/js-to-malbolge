/** Integer assembly expressions. Parsing never evaluates JavaScript. */
export interface AssemblyLocation { filename: string; line: number; column: number }
export class AssemblyError extends SyntaxError {
  constructor(message: string, readonly location: AssemblyLocation) {
    super(`${location.filename}:${location.line}:${location.column}: ${message}`);
    this.name = "AssemblyError";
  }
  get filename() { return this.location.filename; }
  get line() { return this.location.line; }
  get column() { return this.location.column; }
}
export type Expression = { kind: "number"; value: bigint } | { kind: "name"; name: string } |
  { kind: "unary"; op: string; value: Expression } | { kind: "binary"; op: string; left: Expression; right: Expression };
export interface Token { text: string; at: number; value?: bigint }
const precedence: Record<string, number> = {
  "|": 1, "^": 2, "&": 3, "==": 4, "!=": 4, "<": 5, "<=": 5, ">": 5, ">=": 5,
  "<<": 6, ">>": 6, "+": 7, "-": 7, "*": 8, "/": 8, "%": 8,
};
export const atColumn = (location: AssemblyLocation, offset: number): AssemblyLocation => ({ ...location, column: location.column + offset });
export function fail(message: string, location: AssemblyLocation): never { throw new AssemblyError(message, location); }

/** Decode either quote style, with explicit escapes and no interpolation. */
export function readQuoted(text: string, start: number, location: AssemblyLocation): { value: string; end: number } {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") fail("expected a quoted string", atColumn(location, start));
  let value = "", i = start + 1;
  while (i < text.length) {
    const ch = text[i++];
    if (ch === quote) return { value, end: i };
    if (ch !== "\\") { value += ch; continue; }
    const escapeAt = i - 1, escape = text[i++];
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", "'": "'", '"': '"' };
    if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
    if (escape === "x" || escape === "u") {
      const braced = escape === "u" && text[i] === "{";
      const end = braced ? text.indexOf("}", i + 1) : i + (escape === "x" ? 2 : 4);
      const digits = text.slice(i + (braced ? 1 : 0), end);
      if (end < i || !/^[\da-f]+$/i.test(digits) || (!braced && digits.length !== (escape === "x" ? 2 : 4)) || digits.length > 6) fail("invalid character escape", atColumn(location, escapeAt));
      const cp = Number.parseInt(digits, 16);
      if (cp > 0x10ffff) fail("Unicode escape is out of range", atColumn(location, escapeAt));
      value += String.fromCodePoint(cp); i = end + (braced ? 1 : 0); continue;
    }
    fail(`unknown escape \\${escape ?? ""}`, atColumn(location, escapeAt));
  }
  return fail("unterminated string", atColumn(location, start));
}

export function stripComment(text: string, location: AssemblyLocation): string {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' || text[i] === "'") { i = readQuoted(text, i, location).end - 1; continue; }
    if (text[i] === "#" || text[i] === ";" || text.startsWith("//", i)) return text.slice(0, i);
  }
  return text;
}

export function parseExpression(text: string, location: AssemblyLocation, qualify: (name: string) => string, pc: number): Expression {
  const tokens: Token[] = [];
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at++; continue; }
    if (text[at] === "'") {
      const quoted = readQuoted(text, at, location), chars = Array.from(quoted.value);
      if (chars.length !== 1 || (chars[0].codePointAt(0)! >= 0xd800 && chars[0].codePointAt(0)! <= 0xdfff)) fail("character literal requires one Unicode scalar", atColumn(location, at));
      tokens.push({ text: "character", value: BigInt(chars[0].codePointAt(0)!), at }); at = quoted.end; continue;
    }
    const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|0[tT][012_]+|[\d_]+)/.exec(text.slice(at));
    if (number && /^\d/.test(text[at])) {
      const raw = number[0], digits = raw.replace(/^0[xbot]/i, "");
      if (digits.startsWith("_") || digits.endsWith("_") || digits.includes("__")) fail("invalid numeric separator", atColumn(location, at));
      const clean = raw.replaceAll("_", "");
      const value = /^0t/i.test(clean) ? Array.from(clean.slice(2)).reduce((n, d) => n * 3n + BigInt(d), 0n) : BigInt(clean);
      tokens.push({ text: raw, value, at }); at += raw.length; continue;
    }
    const name = /^(?:[A-Za-z_][\w.]*|\.[A-Za-z_][\w.]*|\$)/.exec(text.slice(at));
    if (name) { tokens.push({ text: name[0], at }); at += name[0].length; continue; }
    const operator = /^(?:<<|>>|==|!=|<=|>=|[()+\-*/%~!&|^<>])/.exec(text.slice(at));
    if (!operator) fail(`unexpected character ${JSON.stringify(text[at])}`, atColumn(location, at));
    tokens.push({ text: operator[0], at }); at += operator[0].length;
  }
  let cursor = 0;
  const atom = (depth: number): Expression => {
    const token = tokens[cursor++];
    if (!token) return fail("expected an integer expression", atColumn(location, text.length));
    if (depth > 256) fail("expression nesting exceeds 256", atColumn(location, token.at));
    if (token.value !== undefined) return { kind: "number", value: token.value };
    if (["+", "-", "~", "!"].includes(token.text)) return { kind: "unary", op: token.text, value: atom(depth + 1) };
    if (token.text === "(") {
      const result = binary(1, depth + 1);
      if (tokens[cursor++]?.text !== ")") fail("expected )", atColumn(location, token.at));
      return result;
    }
    if (token.text === "$") return { kind: "number", value: BigInt(pc) };
    if (/^[A-Za-z_.]/.test(token.text)) return { kind: "name", name: qualify(token.text) };
    return fail("expected an integer expression", atColumn(location, token.at));
  };
  const binary = (minimum: number, depth = 0): Expression => {
    let left = atom(depth);
    while (precedence[tokens[cursor]?.text] >= minimum) {
      const op = tokens[cursor++].text, right = binary(precedence[op] + 1, depth + 1);
      left = { kind: "binary", op, left, right };
    }
    return left;
  };
  const result = binary(1);
  if (cursor < tokens.length) fail(`unexpected token ${tokens[cursor].text}`, atColumn(location, tokens[cursor].at));
  return result;
}

export function evaluateExpression(expr: Expression, lookup: (name: string) => bigint, location: AssemblyLocation): bigint {
  // Long left-associative expressions must not consume the host call stack.
  const pending = [{ expression: expr, ready: false }], values: bigint[] = [];
  while (pending.length) {
    const { expression: e, ready } = pending.pop()!;
    if (e.kind === "number") { values.push(e.value); continue; }
    if (e.kind === "name") { values.push(lookup(e.name)); continue; }
    if (!ready) {
      pending.push({ expression: e, ready: true });
      if (e.kind === "binary") pending.push({ expression: e.right, ready: false });
      pending.push({ expression: e.kind === "unary" ? e.value : e.left, ready: false });
    } else if (e.kind === "unary") {
      const value = values.pop()!;
      values.push(e.op === "-" ? -value : e.op === "~" ? ~value : e.op === "!" ? BigInt(!value) : value);
    } else {
      const b = values.pop()!, a = values.pop()!;
      values.push(binaryValue(e.op, a, b, location));
    }
  }
  return values[0];
}
function binaryValue(op: string, a: bigint, b: bigint, location: AssemblyLocation): bigint {
  switch (op) {
    case "+": return a + b; case "-": return a - b; case "*": return a * b;
    case "/": case "%": if (!b) fail("division by zero in assembly expression", location); return op === "/" ? a / b : a % b;
    case "<<": case ">>":
      if (b < 0n || b > 65536n) fail("shift count must be between 0 and 65536", location);
      return op === "<<" ? a << b : a >> b;
    case "&": return a & b; case "|": return a | b; case "^": return a ^ b;
    case "==": return BigInt(a === b); case "!=": return BigInt(a !== b);
    case "<": return BigInt(a < b); case "<=": return BigInt(a <= b); case ">": return BigInt(a > b); case ">=": return BigInt(a >= b);
    default: return fail(`unknown expression operator ${op}`, location);
  }
}
