import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { format } from "node:util";
import { compileJS } from "../src/frontend/index.js";
import { assembleBytecode, decodeBytecode, disassembleBytecode, encodeBytecode, runVM } from "../src/vm/index.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import { runMicroModel } from "./micro-model.js";

const fixtures: [string, string, number][] = [
  ['empty reads and pop', 'const a=[]; console.log(a[0],a[100],a[-1],a.pop(),a.length);', 1],
  ['uninitialized slots', 'const a=[]; a.length=3; a[1]=7; console.log(a[0],a[1],a[2],a.pop(),a.length);', 4],
  ['truncated slots stay missing', 'const a=[1];a.length=0;a.length=1;console.log(a[0],a.pop(),a.pop());', 2],
  ['missing booleans differ from false', 'const a=[false];a.length=2;console.log(a[0],a[1],a[0]===a[1],!a[1],a.pop(),a.pop());', 3],
  ['zero is present', 'const a=[0];console.log(a[0]===undefined,a[1]===undefined,a[0]??7,a[1]??7);', 2],
  ['integer boundaries remain available', 'const a=[-29524,29524,0]; console.log(a[0],a[1],a[2],a[3],a[0]===undefined,a[1]===undefined);', 4],
  ['undefined literals, void, and shadowing', 'console.log(undefined,void 0,undefined===void 0); {let undefined=7;console.log(undefined);} let i=0;console.log(void i++,i);', 1],
  ['uninitialized bindings and assignments', 'let a; console.log(a);a=7;console.log(a);a=undefined;console.log(a);let b=false;console.log(b=undefined);b=true;console.log(b);', 1],
  ['conditional optional values', 'let b=true; console.log(b?undefined:7,b?false:undefined);b=false;console.log(b?undefined:7,b?false:undefined);', 1],
  ['explicit undefined return and void side effects', 'function f(){return undefined;}function noisy(){console.log(7);}console.log(f(),void noisy());', 1],
  ['undefined comparisons', 'console.log(undefined===undefined,undefined!==undefined,undefined==0,undefined==false,undefined!=0,undefined<1,undefined<=undefined,1>undefined);', 1],
  ['optional reference comparisons', 'const a=[{}];const u=a[1];console.log(u===undefined,u==undefined,a[0]===u,a.pop()===u,a.pop()===u);', 3],
  ['truthiness and coalescing', 'const a=[];console.log(!a[0],!!a[0],a[0]||7,a[0]&&3,a[0]??9,0??7,false??true);if(a[0])console.log("wrong");else console.log("missing");', 1],
  ['nullish evaluation order', 'let i=0; console.log(undefined??++i,0??++i,false??true,i);', 1],
  ['user names do not select runtime adapters', 'function $heap(){return undefined;}console.log($heap());', 1],
  ['optional function parameters and returns', 'function f(a){return a.pop();}function id(x){return x;}const a=[7];console.log(id(f(a)),id(f(a)),id(f(a)));', 2],
  ['recursive presence locals', 'function f(n,x){if(n===0)return x;const old=x;const result=f(n-1,undefined);console.log(old,result);return old;}console.log(f(3,7));', 1],
  ['argument presence evaluated before output', 'const a=[3];console.log(a.pop(),a.pop(),a.push(4),a.pop(),a[0]);', 2],
  ['property assignment presence and push length', 'const a=[1];console.log(a[0]=undefined,a.push(undefined),a.length,a.pop(),a[0]);', 3],
  ['pop until undefined', 'const a=[0,1,2];let x;let total=0;while((x=a.pop())!==undefined)total+=x;console.log(total,x,a.length);', 4],
  ['storing undefined in heap', 'const a=[undefined,1];const o={x:2};o.x=a[0];console.log(a[0],a[1],o.x);a.push(o.x);console.log(a.pop());', 6],
  ['undefined array arguments', 'const a=[];a.push(undefined,false);console.log(a[0],a[1],a.pop(),a.pop(),a.pop());', 3],
  ['undefined object reference fields', 'const o={x:{value:7}};o.x=undefined;for(let i=0;i<10;i++)({value:i});console.log(o.x===undefined);o.x={value:8};console.log(o.x.value);', 4],
  ['optional reference roots in recursion', 'function f(a,n){const x=a.pop();if(n===0){for(let i=0;i<10;i++)({value:i});return x;}f(a,n-1);return x;}const a=[{value:7}];const x=f(a,2);console.log(x.value);', 6],
  ['missing reference reused after collection', 'const a=[{value:1}];a.pop();let x=a.pop();for(let i=0;i<10;i++)({value:i});a.push(x);console.log(a.pop()===undefined);x={value:9};a.push(x);console.log(a[0].value);', 5],
  ['reference fallback survives collection', 'const a=[]; const b=a.pop()??{value:7};for(let i=0;i<10;i++)({value:i});console.log(b.value);', 5],
];

describe.each([true,false])('undefined values (optimize=%s)', (optimize) => {
  it.each(fixtures)('matches Node: %s', (_name, source, heapCapacity) => {
    let output='';
    runInNewContext(source,{console:{log:(...args:unknown[])=>{output+=format(...args)+'\n';}}},{timeout:1000});
    const program=compileJS(source,{optimize,heapCapacity,width:10});
    expect(runVM(decodeBytecode(encodeBytecode(program)),{maxSteps:5_000_000})).toMatchObject({status:'halted',output,stack:[],returnStack:[]});
    expect(encodeBytecode(assembleBytecode(disassembleBytecode(program)))).toEqual(encodeBytecode(program));
  });
  it.each(['console.log(undefined+1);','console.log(+undefined);','console.log(Math.trunc(undefined));','const a=[];a.length=undefined;','const a=[];a[undefined]=1;'])(
    'retains faults for unsupported numeric conversions: %s', (source) => {
      expect(()=>runVM(compileJS(source,{optimize,heapCapacity:2}))).toThrow(/division by zero/);
    });
});

it('runs undefined results and GC through native microcode',()=>{
  const source='const a=[]; console.log(a.pop());a.length=1;console.log(a.pop());a.push(0);console.log(a.pop(),a.pop()===undefined);';
  const program=compileJS(source,{width:10,heapCapacity:2});
  expect(runMicroModel(planFullHeLLVM(program,{stackCapacity:32,returnStackCapacity:16}),'',30_000_000))
    .toMatchObject({fault:0,output:'undefined\nundefined\n0 true\n',stack:[]});
},60_000);
