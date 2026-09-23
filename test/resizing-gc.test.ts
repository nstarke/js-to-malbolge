import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { format } from "node:util";
import { compileJS } from "../src/frontend/index.js";
import { assembleBytecode, decodeBytecode, disassembleBytecode, encodeBytecode, runVM } from "../src/vm/index.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import { runMicroModel } from "./micro-model.js";

const fixtures: [string, string, number][] = [
  ['push, pop, and alias identity', 'const a=[1]; const b=a; console.log(a.push(2,3),b.length,a===b,a.pop(),b.pop(),a[0],a.push());', 4],
  ['empty array inference', 'const a=[]; a.push(true); console.log(a[0],a.pop(),a.length);', 2],
  ['indexed growth and length growth', 'const a=[]; a[2]=7; a[0]=3; a[1]=4; console.log(a.length,a[0],a[1],a[2]); a.length=5; a[3]=8; a[4]=9; console.log(a[4],a.length);', 6],
  ['length results and updates', 'const a=[1,2,3]; console.log(a.length=2,a.length--,--a.length,a.length); a.length+=2; a[0]=8; a[1]=9; console.log(a.length,a[0],a[1]);', 5],
  ['push arguments before mutation', 'const a=[1]; console.log(a.push(a.length,a.pop()),a.length,a[0],a[1]);', 3],
  ['method receiver before arguments', 'let a=[1]; const b=a; console.log(a.push((a=[2])[0]),b[1],a.length,b===a);', 5],
  ['assignment re-resolves resized receiver', 'const a=[1,2]; a[0]=(a.length=0,7); console.log(a[0],a.length); a[1]=(a.length=0,8); a[0]=9; console.log(a[0],a[1]);', 5],
  ['compound assignment preserves old value', 'const a=[4]; a[0]+=(a.length=0,3); console.log(a[0]);', 3],
  ['repeated discarded allocation', 'for(let i=0;i<40;i++){({x:i});} console.log(7);', 2],
  ['block lifetime collection', 'for(let i=0;i<40;i++){const a={x:i};console.log(a.x);}', 2],
  ['overwritten bindings', 'let a={x:0}; for(let i=1;i<40;i++) a={x:i}; console.log(a.x);', 4],
  ['reclaimed removed references', 'const a=[]; for(let i=0;i<20;i++){a.push({x:i}); console.log(a.pop().x);}', 4],
  ['reclaimed truncated children', 'const a=[]; for(let i=0;i<20;i++){a.push({x:i}); a.length=0;} a.push({x:8}); console.log(a[0].x);', 4],
  ['scalar values are not roots', 'let n=1; for(let i=0;i<20;i++){const a={x:n}; console.log(a.x);} console.log(n);', 2],
  ['precise heap edge tags', 'const a=[1]; for(let i=0;i<20;i++){const b={x:i};console.log(b.x);} console.log(a[0]);', 4],
  ['caller operand survives collection', 'function churn(){for(let i=0;i<20;i++)({x:i});return {x:2};} function first(a,b){return a;} console.log(first({x:7},churn()).x);', 6],
  ['literal under construction survives collection', 'function churn(){for(let i=0;i<20;i++)({x:i});return 9;} const a={child:{x:8},value:churn()}; console.log(a.child.x,a.value);', 7],
  ['return value survives frame teardown', 'function make(x){return {x};} for(let i=0;i<20;i++){const a=make(i);console.log(a.x);}', 2],
  ['saved recursive roots', 'function f(n){const a={x:n}; if(n===0){for(let i=0;i<20;i++)({x:i});return 0;} return f(n-1)+a.x;} console.log(f(3));', 10],
  ['recursive live expression operands', 'function first(a,b){return a.x+b;} function f(n){if(n===0){for(let i=0;i<20;i++)({x:i});return 0;} return first({x:n},f(n-1));} console.log(f(3));', 8],
  ['identity during collection', 'for(let i=0;i<20;i++)console.log({}==={});', 2],
  ['short circuit roots', 'const a=[];for(let i=0;i<20;i++){const b=a||[];console.log(b===a);}', 1],
  ['backward graph edges', 'function make(){const c={x:9}; return {child:c};} const a=make(); for(let i=0;i<20;i++)({x:i}); console.log(a.child.x);', 6],
  ['mixed object and array cycles', 'function cycle(){const a=[];const o={a};a.push(o);}for(let i=0;i<20;i++)cycle();console.log(7);', 4],
  ['cycles', 'function cycle(){const a=[];a.push(a);} for(let i=0;i<20;i++)cycle(); console.log(7);', 2],
  ['reachable cycles', 'const a=[]; a.push(a); for(let i=0;i<20;i++)({x:i}); console.log(a===a[0],a.length);', 4],
  ['break and continue scope cleanup', 'for(let i=0;i<20;i++){const a={x:i}; if(i%2===0)continue; {const b={x:2};break;}} for(let i=0;i<20;i++)({x:i});console.log(7);', 4],
  ['for initializer scope cleanup', 'for(let a={x:1};a.x<2;a.x++){console.log(a.x);} for(let i=0;i<20;i++)({x:i});console.log(7);', 2],
  ['loop condition temporary cleanup', 'function test(i){return {yes:i<5};} let i=0; while(test(i).yes)i++;console.log(i);', 2],
  ['empty pop result can be replaced after refill', 'const a=[{x:1}]; const b=a.pop(); for(let i=0;i<10;i++)({x:i}); a.push(b); console.log(a[0]===b);', 6],
];

describe.each([true, false])('resizing and collection (optimize=%s)', (optimize) => {
  it.each(fixtures)('matches Node: %s', (_name, source, heapCapacity) => {
    let expected = '';
    runInNewContext(source, { console: { log: (...args: unknown[]) => { expected += format(...args) + '\n'; } } }, { timeout: 1000 });
    const program = compileJS(source, { optimize, heapCapacity, width: 10 });
    const result = runVM(decodeBytecode(encodeBytecode(program)), { maxSteps: 5_000_000 });
    expect(result).toMatchObject({ status: 'halted', output: expected, stack: [], returnStack: [] });
    expect(encodeBytecode(assembleBytecode(disassembleBytecode(program)))).toEqual(encodeBytecode(program));
  });
  it.each([
    'const a=[1]; a.length=-1;',
    'const a=[1]; a[-1]=2;',
    'const a=[1]; a.length=4;', 'const a=[1,2]; a.push(3);',
  ])('faults safely: %s', (source) => {
    expect(() => runVM(compileJS(source, { optimize, heapCapacity: 3 }))).toThrow(/division by zero/);
  });
});

it.each([
  'const a=[1]; a.push(true);', 'const a=[1]; a.length=true;',
  'const a=[1]; a.pop(1);', 'const a={push:1}; a.push(2);', 'const a=[1]; a.push(...[2]);',
])('rejects invalid resizing: %s', (source) => {
  expect(() => compileJS(source)).toThrow();
});

it('collects and resizes with the native register microcode', () => {
  const source = 'const a=[]; for(let i=0;i<3;i++){a.push(i);console.log(a.pop());}';
  const program = compileJS(source, { width: 10, heapCapacity: 2 });
  const result = runMicroModel(planFullHeLLVM(program, { stackCapacity: 32, returnStackCapacity: 16 }), '', 30_000_000);
  expect(result).toMatchObject({ fault: 0, output: '0\n1\n2\n', stack: [] });
}, 60_000);
