import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { format } from "node:util";
import { compileJS } from "../src/frontend/index.js";
import { assembleBytecode, decodeBytecode, disassembleBytecode, encodeBytecode, runVM } from "../src/vm/index.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import { runMicroModel } from "./micro-model.js";

const fixtures = [
  ['object properties and shorthand', 'let x=2; const o={x, "a-b":3, flag:true}; console.log(o.x,o["a-b"],o.flag); o.x+=4; o.flag=false; console.log(o.x,o.flag);'],
  ['array indexing and length', 'const a=[2,4,6]; for(let i=0;i<a.length;i++) a[i]+=i; console.log(a[0],a[1],a[2],a.length, [].length);'],
  ['nested objects and arrays', 'const a=[{x:1, a:[true,false]},{a:[false,true],x:2}]; a[1].a[0]=true; a[0].x++; console.log(a[0].x,a[1].x,a[1].a[0]);'],
  ['aliases and identity', 'const a={x:1}; const b=a; b.x=7; const c={x:7}; console.log(a.x,a===b,a===c,a==b,a!=c,a===1,a!==true); const x=[a]; console.log(x[0]===a, x===x, x=={});'],
  ['truthiness and short circuit', 'let a={x:1}; let b={x:2}; console.log(!a,!![],(a||b).x,(a&&b).x,(a?a:b).x); if(a) console.log(3);'],
  ['updates and assignment values', 'const a=[1,2]; let i=0; console.log(a[i++]++,++a[1],a[0],i,a[0]=9,a[1]*=2,a[1]--,--a[0]);'],
  ['reference captured before RHS', 'let a=[1]; const old=a; a[0]=(a=[2])[0]+3; console.log(old[0],a[0]); let o={x:1}; const prev=o; o.x+=(o={x:8}).x; console.log(prev.x,o.x);'],
  ['literal evaluation order', 'let i=0; const o={z:i++, a:i++, b:i++}; const a=[i++,i++]; console.log(o.z,o.a,o.b,a[0],a[1],i);'],
  ['function arguments and results', 'function make(x){return {value:x};} function edit(o){o.value+=2;return o;} const a=make(3); const b=edit(a); console.log(a.value,b===a,make(3)===a);'],
  ['forward inferred nested members', 'function read(o){return o.child.values[0];} function wrapper(o){return read(o);} console.log(wrapper({child:{values:[9]}}));'],
  ['array parameters of different lengths', 'function last(a){return a[a.length-1];} console.log(last([1]),last([2,3]),last([4,5,6]));'],
  ['canonical object layouts', 'function sum(o){return o.a*10+o.z;} console.log(sum({a:2,z:3}),sum({z:4,a:5}));'],
  ['recursive allocations and escaped results', 'function f(n){let a={x:n}; if(n===0)return a; let b=f(n-1); a.x+=b.x; return a;} console.log(f(4).x);'],
  ['recursive assignment temporaries', 'function f(a,n){if(n===0)return 1; a[n-1]+=f(a,n-1);return a[n-1];} const a=[1,2,3]; console.log(f(a,3),a[0],a[1],a[2]);'],
  ['fresh allocation in loops', 'let old={x:0}; for(let i=1;i<5;i++){let a={x:i};console.log(a===old,old.x);old=a;}'],
  ['array reference replacement', 'let a=[1]; const b=a; a=[2,3]; console.log(a.length,b.length,a===b); const box={values:[4]}; box.values=a; console.log(box.values[1]);'],
  ['object length fields and empty objects', 'const a={length:2}; a.length++; const b={}; console.log(a.length,b===b,b==={},[].length);'],
  ['booleans inferred from member returns', 'function f(o){return o.flag;} console.log(f({flag:true}),f({flag:false}));'],
];

describe.each([true, false])("aggregate frontend (optimize=%s)", (optimize) => {
  it.each(fixtures)("matches Node: %s", (_name, source) => {
    let expected = "";
    runInNewContext(source, { console: { log: (...args: unknown[]) => { expected += format(...args) + "\n"; } } }, { timeout: 1000 });
    const program = compileJS(source, { optimize });
    const actual = runVM(decodeBytecode(encodeBytecode(program)));
    expect(actual).toMatchObject({ status: "halted", output: expected, stack: [], returnStack: [] });
    expect(encodeBytecode(assembleBytecode(disassembleBytecode(program)))).toEqual(encodeBytecode(program));
  });
  it.each(['const a=[1]; console.log(a[-1]);', 'const a=[1]; a[4]=2;', 'console.log([][0]);', 'const a=[1]; console.log(a[29524]);'])("faults safely: %s", (source) => {
    expect(() => runVM(compileJS(source, { optimize, width: 10, heapCapacity: 4 }))).toThrow(/division by zero/);
  });
  it("allows an allocation to fill the heap exactly", () => {
    expect(runVM(compileJS('const a=[1,2]; console.log(a[1]);', { optimize, heapCapacity: 3 })).output).toBe('2\n');
    expect(() => runVM(compileJS('const a=[1,2]; const b={};', { optimize, heapCapacity: 3 }))).toThrow(/division by zero/);
  });
});

it.each([
  ['const a=[1,true];', /incompatible/], ['const a=[1]; a[0]=false;', /incompatible/],
  ['const a={x:1}; a.y=2;', /unknown object property/], ['const a={x:1}; a.x=true;', /incompatible/],
  ['const a=[,1];', /holes/], ['const a=[...[1]];', /spread/],
  ['const a={get x(){return 1;}};', /plain/], ['const a={x(){return 1;}};', /plain/],
  ['const a={...{x:1}};', /plain/], ['const a={__proto__:1};', /property name/],
  ['const a={x:1,x:2};', /duplicate/], ['const a={x:1}; console.log(a[true]);', /incompatible/],
  ['const a=[1]; console.log(a[false]);', /integer/], ['const a=[1]; console.log(a.x);', /numeric indices/],
  ['let a={x:1}; a={y:2};', /incompatible/], ['console.log({x:1});', /incompatible/],
  ['console.log([1]==1);', /coercion/], ['console.log({}!=false);', /coercion/],
  ['console.log([1]+1);', /incompatible/], ['console.log(Math.trunc([]));', /incompatible/],
  ['console.log(-[]);', /incompatible/], ['console.log([1]/2);', /incompatible/],
  ['console.log(1.x);', /Identifier|identifier/], ['const a=1; console.log(a.x);', /incompatible/],
  ['function f(){} const a=[f()];', /incompatible/], ['function f(){} const a={x:f()};', /incompatible/],
  ['if(false){const a={x:1}; a.y=2;}', /unknown object property/],
])("rejects unsupported aggregates: %s", (source, error) => {
  expect(() => compileJS(source, { filename: "aggregate.js" })).toThrow(error);
});

it("validates heap capacity and literal size", () => {
  for (const heapCapacity of [0, -1, 1.5, NaN, 65537, 29524]) {
    expect(() => compileJS('', { heapCapacity, width: 10 })).toThrow(/heapCapacity/);
  }
  expect(() => compileJS('[1,2];', { heapCapacity: 2 })).toThrow(/exceeds heapCapacity/);
});

it("executes aggregate references using the native register microcode", () => {
  const program = compileJS('const a=[{x:2}]; const b=a[0]; b.x+=3; console.log(a[0].x,a.length,b===a[0]);', { width: 10, heapCapacity: 4 });
  const actual = runMicroModel(planFullHeLLVM(program, { stackCapacity: 16 }));
  expect(actual).toMatchObject({ fault: 0, output: '5 1 true\n', stack: [] });
}, 60_000);

it.each(['const a=[1]; console.log(a[1]);', 'const a={}; const b={}; const c={};'])("preserves heap faults in native microcode: %s", (source) => {
  const program = compileJS(source, { width: 10, heapCapacity: 2 });
  expect(runMicroModel(planFullHeLLVM(program, { stackCapacity: 16 })).fault).toBe(7);
});
