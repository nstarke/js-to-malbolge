import { parse, type Node, type Expression, type Statement, type FunctionDeclaration, type VariableDeclaration, type CallExpression, type Program } from "acorn";
import { wordModulus, type BytecodeProgram, type SimpleOp } from "../vm/isa.js";
import { lowerIR, type IR, type Label, type Frame } from "./ir.js";
import { JSCompileError, ValueType, NUMBER, BOOLEAN, VOID, SCALAR } from "./types.js";

export interface CompileOptions {
  /** Logical signed ternary word width; defaults to 20. */
  width?: number;
  /** Used in source diagnostics. */
  filename?: string;
}
interface Binding { index: number; type: ValueType; mutable: boolean; ready: boolean; owner?: FunctionInfo }
interface Scope { parent?: Scope; bindings: Map<string, Binding> }
interface FunctionInfo {
  node: FunctionDeclaration;
  entry: Label;
  exit: Label;
  params: Binding[];
  result: ValueType;
  frame: Frame;
}

/** Compile the documented integer/scalar JavaScript subset without executing it. */
export function compileJS(source: string, options: CompileOptions = {}): BytecodeProgram {
  const width = options.width ?? 20;
  wordModulus(width);
  let ast: Program;
  try { ast = parse(source, { ecmaVersion: 2022, sourceType: "script", locations: true }); }
  catch (error) {
    if (error instanceof SyntaxError && "loc" in error) {
      const loc = error.loc as { line: number; column: number };
      throw new JSCompileError(error.message.replace(/ \(\d+:\d+\)$/, ""), { loc: { start: loc, end: loc } }, options.filename);
    }
    throw error;
  }
  return new Compiler(width, options.filename).compile(ast);
}

class Compiler {
  private readonly code: IR[] = [];
  private readonly globals: Scope = { bindings: new Map() };
  private scope = this.globals;
  private readonly functions = new Map<string, FunctionInfo>();
  private currentFunction?: FunctionInfo;
  private readonly loops: { break: Label; continue: Label }[] = [];
  private localCount = 0;
  private labelCount = 0;
  constructor(private readonly width: number, private readonly filename?: string) {}
  private fail(node: Node, message: string): never { throw new JSCompileError(message, node, this.filename); }
  private label(name: string): Label { return { name: `${name}.${this.labelCount++}` }; }
  private mark(label: Label): void { this.code.push({ op: "label", label }); }
  private emit(op: SimpleOp): void { this.code.push({ op }); }
  private push(value: bigint): void { this.code.push({ op: "push", value }); }
  private branch(op: "jump" | "jz" | "call", target: Label): void { this.code.push({ op, target }); }
  private slot(owner = this.currentFunction): number {
    const index = this.localCount++;
    if (this.localCount > 1_000_000) throw new RangeError("compiler local count exceeds the bytecode limit");
    owner?.frame.slots.push(index);
    return index;
  }
  private constrain(type: ValueType, mask: number, node: Node): ValueType {
    type.constrain(mask, () => this.fail(node, "incompatible value type; expected " + (mask === NUMBER ? "an integer" : mask === VOID ? "no return value" : "an integer or boolean")));
    return type;
  }
  private same(a: ValueType, b: ValueType, node: Node): void {
    a.unify(b, () => this.fail(node, "incompatible value types; bindings, function signatures, and expression branches must keep one type"));
  }
  private lookup(name: string): Binding | undefined {
    for (let scope: Scope | undefined = this.scope; scope; scope = scope.parent) {
      const found = scope.bindings.get(name); if (found) return found;
    }
  }
  private binding(node: Node & { name: string }, write = false): Binding {
    const binding = this.lookup(node.name);
    if (!binding) this.fail(node, `unknown variable ${node.name}; functions are only supported in direct calls`);
    if (binding.owner !== this.currentFunction) this.fail(node, `capturing outer variable ${node.name} is not supported; pass it as an argument`);
    if (!binding.ready) this.fail(node, `${node.name} is used before its declaration is initialized`);
    if (write && !binding.mutable) this.fail(node, `cannot assign to const ${node.name}`);
    return binding;
  }
  private predeclare(statements: Statement[]): void {
    for (const statement of statements) {
      if (statement.type !== "VariableDeclaration") continue;
      if (statement.kind !== "let" && statement.kind !== "const") this.fail(statement, "only let and const declarations are supported");
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier") this.fail(declaration.id, "destructuring declarations are not supported");
        const name = declaration.id.name;
        if (this.scope.bindings.has(name) || this.scope === this.globals && this.functions.has(name)) this.fail(declaration.id, `duplicate declaration ${name}`);
        this.scope.bindings.set(name, { index: this.slot(), type: new ValueType(SCALAR), mutable: statement.kind === "let", ready: false, owner: this.currentFunction });
      }
    }
  }
  compile(ast: Program): BytecodeProgram {
    // Parsing as a script excludes import/export declarations.
    const statements = ast.body as Statement[];
    for (const node of statements) {
      if (node.type !== "FunctionDeclaration") continue;
      if (node.async || node.generator) this.fail(node, "async and generator functions are not supported");
      if (this.functions.has(node.id.name)) this.fail(node, `duplicate function ${node.id.name}`);
      const info: FunctionInfo = { node, entry: this.label(node.id.name), exit: this.label(`${node.id.name}.return`), params: [], result: new ValueType(), frame: { slots: [], params: [], incoming: [] } };
      const names = new Set<string>();
      for (const param of node.params) {
        if (param.type !== "Identifier") this.fail(param, "parameters must be plain identifiers without defaults or rest syntax");
        if (names.has(param.name)) this.fail(param, `duplicate parameter ${param.name}`);
        names.add(param.name);
        const index = this.slot(info);
        info.params.push({ index, type: new ValueType(SCALAR), mutable: true, ready: true, owner: info });
        info.frame.params.push(index);
        // Incoming argument slots are scratch cells, not saved frame members.
        info.frame.incoming.push(this.slot());
      }
      this.functions.set(node.id.name, info);
    }
    this.predeclare(statements);
    this.statements(statements);
    this.emit("halt");
    for (const info of this.functions.values()) this.functionBody(info);
    return lowerIR(this.code, this.width, this.localCount);
  }
  private functionBody(info: FunctionInfo): void {
    this.currentFunction = info;
    this.scope = { parent: this.globals, bindings: new Map() };
    info.node.params.forEach((param, i) => this.scope.bindings.set((param as { name: string }).name, info.params[i]));
    this.predeclare(info.node.body.body);
    this.mark(info.entry); this.code.push({ op: "enter", frame: info.frame });
    if (this.statements(info.node.body.body)) {
      this.constrain(info.result, VOID, info.node);
      this.push(0n); // Internal dummy for void calls, never exposed as a JS value.
    }
    this.mark(info.exit); this.code.push({ op: "leave", frame: info.frame });
    this.currentFunction = undefined; this.scope = this.globals;
  }
  /** Returns whether control can reach the next statement. */
  private statements(statements: Statement[]): boolean {
    let fallsThrough = true;
    for (const statement of statements) {
      const falls = this.statement(statement);
      fallsThrough = fallsThrough && falls;
    }
    return fallsThrough;
  }
  private statement(node: Statement): boolean {
    switch (node.type) {
      case "EmptyStatement": return true;
      case "FunctionDeclaration":
        if (this.scope !== this.globals || this.currentFunction) this.fail(node, "only top-level function declarations are supported");
        return true;
      case "BlockStatement": {
        const previous = this.scope; this.scope = { parent: previous, bindings: new Map() };
        this.predeclare(node.body); const falls = this.statements(node.body); this.scope = previous; return falls;
      }
      case "VariableDeclaration": this.declaration(node); return true;
      case "ExpressionStatement":
        if (node.expression.type === "CallExpression" && this.isBuiltin(node.expression, "console", "log")) this.log(node.expression);
        else { this.expression(node.expression); this.emit("drop"); }
        return true;
      case "IfStatement": {
        const otherwise = this.label("else"), done = this.label("endif");
        this.condition(node.test); this.branch("jz", otherwise);
        const left = this.statement(node.consequent); this.branch("jump", done); this.mark(otherwise);
        const right = node.alternate ? this.statement(node.alternate) : true;
        this.mark(done); return left || right;
      }
      case "WhileStatement": case "DoWhileStatement": {
        const body = this.label("loop"), test = this.label("test"), done = this.label("endloop");
        if (node.type === "WhileStatement") this.branch("jump", test);
        this.mark(body); this.loops.push({ break: done, continue: test }); this.statement(node.body); this.loops.pop();
        this.mark(test); this.condition(node.test); this.branch("jz", done); this.branch("jump", body); this.mark(done);
        return true;
      }
      case "ForStatement": {
        const previous = this.scope; this.scope = { parent: previous, bindings: new Map() };
        if (node.init?.type === "VariableDeclaration") { this.predeclare([node.init]); this.declaration(node.init); }
        else if (node.init) { this.expression(node.init); this.emit("drop"); }
        const test = this.label("for.test"), update = this.label("for.update"), done = this.label("for.end");
        this.mark(test);
        if (node.test) { this.condition(node.test); this.branch("jz", done); }
        this.loops.push({ break: done, continue: update }); this.statement(node.body); this.loops.pop();
        this.mark(update); if (node.update) { this.expression(node.update); this.emit("drop"); }
        this.branch("jump", test); this.mark(done); this.scope = previous;
        return true;
      }
      case "BreakStatement": case "ContinueStatement": {
        const loop = this.loops.at(-1);
        if (node.label || !loop) this.fail(node, "break and continue require an unlabeled enclosing loop");
        this.branch("jump", node.type === "BreakStatement" ? loop.break : loop.continue); return false;
      }
      case "ReturnStatement": {
        const info = this.currentFunction;
        if (!info) this.fail(node, "return requires a function");
        const result = node.argument ? this.expression(node.argument) : (this.push(0n), new ValueType(VOID));
        this.same(info.result, result, node); this.branch("jump", info.exit); return false;
      }
      default: return this.fail(node, `unsupported JavaScript statement ${node.type}`);
    }
  }
  private declaration(node: VariableDeclaration): void {
    for (const declaration of node.declarations) {
      if (declaration.id.type !== "Identifier") this.fail(declaration.id, "destructuring declarations are not supported");
      if (!declaration.init) this.fail(declaration, "declarations require an initializer; undefined is not a VM value");
      const binding = this.scope.bindings.get(declaration.id.name)!;
      const type = this.expression(declaration.init);
      this.same(binding.type, type, declaration); this.code.push({ op: "store", index: binding.index }); binding.ready = true;
    }
  }
  private condition(node: Expression): void { this.constrain(this.expression(node), SCALAR, node); }
  private expression(node: Expression): ValueType {
    switch (node.type) {
      case "Literal":
        if (typeof node.value === "boolean") { this.push(BigInt(node.value)); return new ValueType(BOOLEAN); }
        if (typeof node.value !== "number" || !Number.isSafeInteger(node.value)) this.fail(node, "expected a safe integer or boolean; strings are supported only as console.log arguments");
        this.push(BigInt(node.value)); return new ValueType(NUMBER);
      case "Identifier": {
        const binding = this.binding(node); this.code.push({ op: "load", index: binding.index }); return binding.type;
      }
      case "UnaryExpression": {
        if (!["+", "-", "!"].includes(node.operator)) this.fail(node, `unsupported unary operator ${node.operator}`);
        if (node.operator === "-") this.push(0n);
        this.condition(node.argument);
        if (node.operator === "!") { this.push(0n); this.emit("eq"); return new ValueType(BOOLEAN); }
        if (node.operator === "-") this.emit("sub");
        return new ValueType(NUMBER);
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateIdentifier") this.fail(node, "private fields are not supported");
        const arithmetic: Record<string, SimpleOp> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod" };
        if (![...Object.keys(arithmetic), "<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(node.operator)) this.fail(node, `unsupported binary operator ${node.operator}`);
        const left = this.constrain(this.expression(node.left), SCALAR, node.left), right = this.constrain(this.expression(node.right), SCALAR, node.right);
        if (arithmetic[node.operator]) { this.emit(arithmetic[node.operator]); return new ValueType(NUMBER); }
        if (["===", "!=="].includes(node.operator)) this.code.push({ op: "strict-eq", left, right });
        else if (["==", "!="].includes(node.operator)) this.emit("eq");
        else { if (node.operator.startsWith(">")) this.emit("swap"); this.emit(node.operator.endsWith("=") ? "le" : "lt"); }
        if (["!=", "!=="].includes(node.operator)) { this.push(0n); this.emit("eq"); }
        return new ValueType(BOOLEAN);
      }
      case "LogicalExpression": {
        if (node.operator === "??") this.fail(node, "nullish coalescing is not supported");
        const right = this.label("logical.right"), done = this.label("logical.done");
        const type = this.constrain(this.expression(node.left), SCALAR, node.left); this.emit("dup");
        this.branch("jz", node.operator === "&&" ? done : right);
        if (node.operator === "||") { this.branch("jump", done); this.mark(right); }
        this.emit("drop"); this.same(type, this.expression(node.right), node); this.mark(done); return type;
      }
      case "ConditionalExpression": {
        const alternate = this.label("conditional.else"), done = this.label("conditional.end");
        this.condition(node.test); this.branch("jz", alternate);
        const type = this.expression(node.consequent); this.branch("jump", done); this.mark(alternate);
        this.same(type, this.expression(node.alternate), node); this.mark(done); return type;
      }
      case "AssignmentExpression": {
        if (node.left.type !== "Identifier") this.fail(node.left, "only assignments to scalar variables are supported");
        const binding = this.binding(node.left, true);
        const compound: Record<string, SimpleOp> = { "+=": "add", "-=": "sub", "*=": "mul", "/=": "div", "%=": "mod" };
        if (node.operator !== "=" && !compound[node.operator]) this.fail(node, `unsupported assignment operator ${node.operator}`);
        if (node.operator !== "=") { this.constrain(binding.type, NUMBER, node.left); this.code.push({ op: "load", index: binding.index }); }
        const type = this.expression(node.right);
        if (node.operator === "=") this.same(binding.type, type, node);
        else { this.constrain(type, SCALAR, node.right); this.emit(compound[node.operator]); }
        this.emit("dup"); this.code.push({ op: "store", index: binding.index }); return binding.type;
      }
      case "UpdateExpression": {
        if (node.argument.type !== "Identifier") this.fail(node.argument, "updates require a scalar variable");
        const binding = this.binding(node.argument, true); this.constrain(binding.type, NUMBER, node);
        this.code.push({ op: "load", index: binding.index }); if (!node.prefix) this.emit("dup");
        this.push(1n); this.emit(node.operator === "++" ? "add" : "sub"); if (node.prefix) this.emit("dup");
        this.code.push({ op: "store", index: binding.index }); return binding.type;
      }
      case "SequenceExpression": {
        let type = new ValueType();
        node.expressions.forEach((expression, i) => { if (i) this.emit("drop"); type = this.expression(expression); });
        return type;
      }
      case "CallExpression": return this.call(node);
      default: return this.fail(node, `unsupported JavaScript expression ${node.type}`);
    }
  }
  private isBuiltin(node: CallExpression, object: string, property: string): boolean {
    const callee = node.callee;
    return !node.optional && callee.type === "MemberExpression" && !callee.computed && !callee.optional &&
      callee.object.type === "Identifier" && callee.object.name === object && callee.property.type === "Identifier" && callee.property.name === property &&
      !this.lookup(object) && !this.functions.has(object);
  }
  private call(node: CallExpression): ValueType {
    if (this.isBuiltin(node, "Math", "trunc")) {
      if (node.arguments.length !== 1 || node.arguments[0].type === "SpreadElement") this.fail(node, "Math.trunc takes one scalar argument");
      this.condition(node.arguments[0]); return new ValueType(NUMBER);
    }
    if (node.optional || node.callee.type !== "Identifier" || this.lookup(node.callee.name)) this.fail(node, "only direct top-level function calls, Math.trunc, and console.log statements are supported");
    const info = this.functions.get(node.callee.name);
    if (!info) this.fail(node, `unknown function ${node.callee.name}`);
    if (node.arguments.length !== info.params.length) this.fail(node, `${node.callee.name} expects ${info.params.length} arguments`);
    for (const [i, argument] of node.arguments.entries()) {
      if (argument.type === "SpreadElement") this.fail(argument, "spread arguments are not supported");
      this.same(info.params[i].type, this.expression(argument), argument);
    }
    this.branch("call", info.entry); return info.result;
  }
  private text(value: string, node: Node): void {
    const half = (wordModulus(this.width) - 1n) / 2n;
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff) this.fail(node, "strings must contain valid Unicode scalar values");
      if (BigInt(cp) > half) this.fail(node, `Unicode character does not fit width ${this.width}; choose a larger --width`);
      this.push(BigInt(cp)); this.emit("putc");
    }
  }
  private log(node: CallExpression): void {
    const first = node.arguments[0];
    const format = first?.type === "Literal" && typeof first.value === "string" ? first.value :
      first?.type === "TemplateLiteral" && !first.expressions.length ? first.quasis[0].value.cooked : undefined;
    if (node.arguments.length > 1 && format && /%[%sdifjoOc]/.test(format)) this.fail(first, "console.log format substitutions are not supported");
    // JS evaluates every argument before console.log prints any of them.
    const args = node.arguments.map((argument) => {
      if (argument.type === "SpreadElement") this.fail(argument, "spread arguments are not supported");
      if (argument.type === "Literal" && typeof argument.value === "string") return { text: argument.value, node: argument };
      if (argument.type === "TemplateLiteral" && !argument.expressions.length) return { text: argument.quasis[0].value.cooked!, node: argument };
      const type = this.constrain(this.expression(argument), SCALAR, argument), index = this.slot();
      this.code.push({ op: "store", index }); return { type, index, node: argument };
    });
    args.forEach((arg, i) => {
      if (i) this.text(" ", node);
      if (arg.text !== undefined) this.text(arg.text, arg.node);
      else { this.code.push({ op: "load", index: arg.index! }, { op: "print", type: arg.type! }); }
    });
    this.text("\n", node);
  }
}
