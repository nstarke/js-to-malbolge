import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { format } from "node:util";
import { readFileSync } from "node:fs";
import { compileJS, JSCompileError } from "../src/frontend/index.js";
import { assembleBytecode, decodeBytecode, disassembleBytecode, encodeBytecode, runVM } from "../src/vm/index.js";

function nodeOutput(source: string): string {
  let output = "";
  runInNewContext(source, { console: { log: (...args: unknown[]) => { output += format(...args) + "\n"; } } }, { timeout: 1000 });
  return output;
}
function compare(source: string) {
  const program = compileJS(source), result = runVM(decodeBytecode(encodeBytecode(program)));
  expect(result.status).toBe("halted");
  expect(result.output).toBe(nodeOutput(source));
  expect(result.stack).toEqual([]);
  expect(result.returnStack).toEqual([]);
  expect(encodeBytecode(assembleBytecode(disassembleBytecode(program)))).toEqual(encodeBytecode(program));
  return result;
}

describe("JavaScript scalar frontend", () => {
  it("lowers literal output directly into bytecode for the existing native interpreter", () => {
    const source = readFileSync(new URL("../examples/hello.js", import.meta.url), "utf8");
    expect(compileJS(source, { width: 10 })).toEqual(assembleBytecode("putci 72\nputci 105\nputci 10\nhalt"));
    compare(source);
  });
  it.each([
    ["numeric and boolean output", 'console.log(0, 1, -42, 1234567, true, false); console.log();'],
    ["Unicode and literal templates", 'console.log("hé🙂", `line\\nnext`, "100%");'],
    ["scopes and declarations", 'let a = 2, b = a + 3; { const a = 9; console.log(a, b); } console.log(a, b);'],
    ["arithmetic and comparisons", 'let a = 17, b = 5; console.log(a+b, a-b, a*b, Math.trunc(a/b), a%b); console.log(a<b, a<=b, a>b, a>=b, a===b, a!==b);'],
    ["scalar coercion and strict equality", 'console.log(true + true, +false, -true, true == 1, true === 1, false != 0, false !== 0, true === true);'],
    ["prefix, postfix, and assignment results", 'let i = 2; console.log(i++, ++i, i--, --i, i += 3, i *= 2, i %= 3, i);'],
    ["short circuit and operand values", 'let x=0; console.log(0 && (x=9), 3 || (x=8), 0 || (x=4), 7 && (x=5), x);'],
    ["short circuit booleans", 'let b=false; console.log(b && (b=true), !b || (b=true), b, !false);'],
    ["conditional and sequence expressions", 'let x=0; console.log(true ? (x=2) : (x=9), false ? 8 : 3, (x++, x+1), x);'],
    ["while and do-while", 'let i=0; while(i<3) { console.log(i++); } do { console.log(i--); } while(i>0);'],
    ["nested loops, break and continue", 'for(let i=0;i<4;i++){ if(i===1)continue; for(let j=0;j<3;j++){ if(j===2)break; console.log(i,j); }}'],
    ["for scopes and missing clauses", 'let i=9; for(let i=0;i<2;i++)console.log(i); for(;;){i--;if(i===6)break;} console.log(i);'],
    ["do-while continue target", 'let i=0; do {i++; if(i<3)continue;console.log(i);}while(i<4);'],
    ["argument evaluation before output", 'let x=1; console.log(x, x=2, x++); console.log(x);'],
  ])("matches Node for %s", (_name, source) => { compare(source); });

  it("compiles JS FizzBuzz with runtime branches and agrees with Node", () => {
    const source = readFileSync(new URL("../examples/fizzbuzz.js", import.meta.url), "utf8");
    const program = compileJS(source);
    expect(program.instructions.some((inst) => inst.op === "jz")).toBe(true);
    expect(program.instructions.some((inst) => inst.op === "modi")).toBe(true);
    expect(compare(source).output.split("\n")).toHaveLength(101);
  });
  it("uses documented modular integer arithmetic and truncating division", () => {
    const result = runVM(compileJS("console.log(29524 + 1, -29524 - 1, -7 / 3, -7 % 3);", { width: 10 }));
    expect(result.output).toBe("-29524 29524 -2 -1\n");
  });
  it("compiles loops without running them on the host", () => {
    const program = compileJS("while (true) {}");
    expect(runVM(program, { maxSteps: 100 }).status).toBe("step-limit");
  });
});

describe("function lowering and activation records", () => {
  it.each([
    ["forward calls and nested calls", 'console.log(twice(4)); function twice(x){return add(x,x);} function add(a,b){return a+b;}'],
    ["recursion with live locals", 'function fact(n){let x=n;if(n<=1)return 1;let rest=fact(n-1);return x*rest;} console.log(fact(7));'],
    ["multiple recursive expressions", 'function fib(n){if(n<2)return n;return fib(n-1)+fib(n-2);}console.log(fib(10));'],
    ["mutual recursion and boolean returns", 'function even(n){if(n===0)return true;return odd(n-1);}function odd(n){if(n===0)return false;return even(n-1);}console.log(even(8),odd(8));'],
    ["recursive argument side effects", 'function f(n){if(n===0)return 0;let r=f(--n);return r+n;}console.log(f(5));'],
    ["preserving earlier arguments during recursion", 'function sum(a,b){return a+b;}function f(n){if(n<1)return 2;return sum(n,f(n-1));}console.log(f(4));'],
    ["recursive console arguments", 'function f(n){if(n<1)return 0;console.log(n,f(n-1),n);return n;}console.log(f(3));'],
    ["void procedures and explicit return", 'function hello(b){if(b){console.log("yes");return;}console.log("no");}hello(true);hello(false);'],
    ["boolean parameters", 'function invert(b){return !b;}console.log(invert(false),invert(true));'],
    ["functions and caller block shadowing", 'function f(x){return x+1;} {let x=10;console.log(f(x),x);}'],
    ["output before the outer console call", 'function noisy(){console.log("inner");return 7;}console.log("outer",noisy());'],
  ])("matches Node for %s", (_name, source) => { compare(source); });
});

describe("explicit subset diagnostics", () => {
  it.each([
    ["var x=1;", /let and const/],
    ["let x=1.5;", /safe integer/], ["let x=9007199254740992;", /safe integer/], ["let x=1n;", /safe integer/],
    ["const x=1; x=2;", /const/], ["const x=1; x++;", /const/],
    ["let x=x;", /before.*initialized/], ["let x=1; {console.log(x);let x=2;}", /before.*initialized/],
    ["let x=1; x=true;", /incompatible/], ["let x=true; x++;", /integer/],
    ["console.log(true ? 1 : false);", /incompatible/], ["console.log(1 && true);", /incompatible/],
    ["console.log(noSuchName);", /unknown variable/], ["let x='hi';", /strings/], ["console.log(`x=${1}`);", /TemplateLiteral/],
    ["console.log('%d',1);", /format substitutions/], ["console.log('%%',1);", /format substitutions/],
    ["let console=1; console.log('x');", /direct top-level/],
    ["let Math=1; console.log(Math.trunc(2));", /direct top-level/],
    ["function f(x){return x;} f();", /expects 1/],
    ["function f(x){return x;} f(1);f(true);", /incompatible/],
    ["function f(x){if(x)return 1;} f(1);", /return value/],
    ["function f(){} console.log(f());", /incompatible/],
    ["let x=1;function f(){return x;}", /capturing outer variable/],
    ["function f(){function g(){return 1;}return g();}", /top-level/],
    ["const f=(x)=>x;", /ArrowFunctionExpression/],
    ["function f(x=1){return x;}", /plain identifiers/],
    ["async function f(){return 1;}", /async/],
    ["console.log(1 << 2);", /binary operator/],
    ["console.log('\\ud800');", /Unicode scalar/],
  ])("rejects %s", (source, error) => { expect(() => compileJS(source)).toThrow(error); });
  it("reports filenames, lines and columns for semantic and parse errors", () => {
    try { compileJS("let a=1;\nconsole.log(missing);", { filename: "example.js" }); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(JSCompileError);
      expect(error).toMatchObject({ filename: "example.js", line: 2, column: 13 });
      expect(String(error)).toContain("example.js:2:13:");
    }
    expect(() => compileJS("let =", { filename: "bad.js" })).toThrow(/bad.js:1:/);
    expect(() => compileJS('console.log("🙂");', { width: 10 })).toThrow(/larger --width/);
    expect(() => compileJS("", { width: 9 })).toThrow(/width/);
  });
});
