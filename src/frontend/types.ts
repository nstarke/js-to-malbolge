import type { Node } from "acorn";

export class JSCompileError extends SyntaxError {
  readonly line: number;
  readonly column: number;
  constructor(message: string, node: Pick<Node, "loc">, readonly filename = "<input>") {
    const { line, column } = node.loc?.start ?? { line: 1, column: 0 };
    super(`${filename}:${line}:${column + 1}: ${message}`);
    this.name = "JSCompileError";
    this.line = line;
    this.column = column + 1;
  }
}

export const NUMBER = 1, BOOLEAN = 2, VOID = 4, SCALAR = NUMBER | BOOLEAN;
/** Unification lets forward calls and recursion infer scalar parameter/return types. */
export class ValueType {
  private parent?: ValueType;
  constructor(private allowed = SCALAR | VOID) {}
  private root(): ValueType {
    if (this.parent) return this.parent = this.parent.root();
    return this;
  }
  constrain(allowed: number, fail: () => never): void {
    const root = this.root(), common = root.allowed & allowed;
    if (!common) fail();
    root.allowed = common;
  }
  unify(other: ValueType, fail: () => never): void {
    const a = this.root(), b = other.root(), common = a.allowed & b.allowed;
    if (!common) fail();
    if (a !== b) { b.parent = a; a.allowed = common; }
  }
  /** Unconstrained, unobservable scalar parameters default to numbers. */
  kind(): number {
    const allowed = this.root().allowed;
    return allowed & NUMBER ? NUMBER : allowed & BOOLEAN ? BOOLEAN : VOID;
  }
}
