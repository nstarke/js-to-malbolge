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

export const NUMBER = 1, BOOLEAN = 2, VOID = 4, OBJECT = 8, ARRAY = 16;
export const SCALAR = NUMBER | BOOLEAN, VALUE = SCALAR | OBJECT | ARRAY;
type Shape = { kind: typeof OBJECT; fields: Map<string, ValueType> } | { kind: typeof ARRAY; element: ValueType };
/** Unification lets forward calls and recursion infer parameter/return types. */
export class ValueType {
  private parent?: ValueType;
  constructor(private allowed = VALUE | VOID, private shape?: Shape) {}
  static object(fields: Map<string, ValueType>): ValueType { return new ValueType(OBJECT, { kind: OBJECT, fields }); }
  static array(element = new ValueType(VALUE)): ValueType { return new ValueType(ARRAY, { kind: ARRAY, element }); }
  aggregate(): Shape | undefined { return this.root().shape; }
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
    if (a === b) return;
    const x = a.shape, y = b.shape;
    if (x?.kind === OBJECT && y?.kind === OBJECT &&
      (x.fields.size !== y.fields.size || [...x.fields.keys()].some((key) => !y.fields.has(key)))) fail();
    b.parent = a; a.allowed = common; a.shape ??= y;
    if (x?.kind === ARRAY && y?.kind === ARRAY) x.element.unify(y.element, fail);
    if (x?.kind === OBJECT && y?.kind === OBJECT) for (const [key, type] of x.fields) type.unify(y.fields.get(key)!, fail);
  }
  /** Unconstrained, unobservable scalar parameters default to numbers. */
  kind(): number {
    const allowed = this.root().allowed;
    return allowed & NUMBER ? NUMBER : allowed & BOOLEAN ? BOOLEAN : allowed & OBJECT ? OBJECT : allowed & ARRAY ? ARRAY : VOID;
  }
}
