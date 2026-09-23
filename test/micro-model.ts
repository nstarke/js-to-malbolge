/** Independent execution model for testing the VM's shared register routines. */
import { crazy, fromBigInt, rotate, toBigInt, type Trits } from "../src/malbolge/trits.js";
import { normalizeWord } from "../src/vm/isa.js";
import { HELL_VM_FAULTS } from "../src/vm/faults.js";
import { planFullHeLLVM } from "../src/vm/full.js";
import type { BankWord } from "../src/hell/bootstrap.js";
import type { MicroLabel, MicroRegister } from "../src/vm/micro.js";

export function runMicroModel(plan: ReturnType<typeof planFullHeLLVM>, input = "", maxSteps = 10_000_000) {
  const basis = 3n ** 60n, address = (p: BankWord) => BigInt(p.bank) * basis + BigInt(p.offset), word = (p: BankWord) => fromBigInt(address(p));
  const memory = new Map<bigint, Trits>();
  for (const patch of plan.patches) if (patch.at.bank === 700 || patch.at.bank === 728) memory.set(address(patch.at), typeof patch.value === "string" ? patch.value : word(patch.value));
  const b = plan.microcode, read = (r: MicroRegister) => memory.get(address(r.frame.fields[0]))!;
  const write = (r: MicroRegister, value: Trits) => memory.set(address(r.frame.fields[0]), value);
  const indirect = (pointer: Trits, field: number) => toBigInt(memory.get(toBigInt(pointer)! + 4n)!)! + 18n + BigInt(field * 94);
  const target = (label: MicroLabel) => b.labels.get(label.label)!;
  const entries = new Map(plan.microRecords.map((frame, i) => [word(frame.pointer), i]));
  const modulus = 3n ** BigInt(plan.program.width);
  const chars = Array.from(input, (ch) => ch.codePointAt(0)!);
  let inputAt = 0, output = "", pc = target(b.label("fetch")), steps = 0;
  let fault: number | undefined;
  for (; steps < maxSteps; steps++) {
    const inst = b.instructions[pc];
    if (!inst) throw new Error(`micro model fell off at ${pc}`);
    const a = inst.a as MicroRegister, dest = inst.b as MicroRegister;
    if (inst.op.startsWith("fault.")) { fault = HELL_VM_FAULTS[inst.op.slice(6) as keyof typeof HELL_VM_FAULTS]; break; }
    switch (inst.op) {
      case "mov": case "mov1": write(dest, read(a)); break;
      case "split": { const value = toBigInt(read(a))!; write(a, fromBigInt(value / 3n)); write(dest, fromBigInt(value % 3n)); break; }
      case "p": case "p1": write(dest, crazy(read(a), read(dest))); break;
      case "rotate": write(a, rotate(read(a), 132)); break;
      case "top": { let value = read(a); for (let i = 0; i < plan.program.width - 1; i++) value = rotate(value, 132); write(a, value); break; }
      case "cycle": write(a, fromBigInt(toBigInt(read(a))! * 3n)); break;
      case "rol": { const value = toBigInt(read(a))!; write(a, fromBigInt(value * 3n % modulus + value / (modulus / 3n))); break; }
      case "jump": pc = target(inst.a as MicroLabel); continue;
      case "ijump": pc = entries.get(read(a))!; continue;
      case "jz": if (toBigInt(read(a)) === 0n) { pc = target(inst.b as MicroLabel); continue; } break;
      case "branch3": { const value = Number(toBigInt(read(a))); pc = target([inst.b, inst.c, inst.d][value] as MicroLabel); continue; }
      case "out": output += String.fromCodePoint(Number(toBigInt(read(a)))); break;
      case "in": {
        const cp = chars[inputAt++], special = cp === undefined || cp === 10;
        write(a, fromBigInt(special ? 3n ** 20n - (cp === 10 ? 2n : 1n) : BigInt(cp)));
        write(dest, fromBigInt(special ? 2n : 0n)); break;
      }
      default:
        if (inst.op.startsWith("get")) write(dest, memory.get(indirect(read(a), Number(inst.op.slice(3))))!);
        else if (inst.op.startsWith("put")) memory.set(indirect(read(dest), Number(inst.op.slice(3))), read(a));
        else throw new Error(`unknown micro opcode ${inst.op}`);
    }
    pc++;
  }
  const sp = read(b.registers.get("sp")!), depth = plan.stack.findIndex((f) => word(f.pointer) === sp);
  const vmPC = plan.records.findIndex((f) => word(f.pointer) === read(b.registers.get("pc")!));
  const stack = plan.stack.slice(1, depth + 1).map((f) => normalizeWord(toBigInt(memory.get(address(f.fields[0]))!)!, modulus));
  const locals = plan.locals.map((f) => normalizeWord(toBigInt(memory.get(address(f.fields[0]))!)!, modulus));
  return { fault, output, pc: vmPC, stack, locals, steps };
}
