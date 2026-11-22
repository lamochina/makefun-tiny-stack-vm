// A tiny stack virtual machine (the published ISA): runs each
// /input/<id>/ program.bin and writes its stdout.bin and exit.txt.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_STEPS = 1_000_000;
const MAX_OUT = 65_536;
const MAX_STACK = 256;
const MAX_CALLS = 64;
const MEMORY = 256;

// A trap ends a program; its number is the exit code.
class Trap {
  code: number;
  constructor(code: number) { this.code = code; }
}

function run(prog: Uint8Array, input: Uint8Array) {
  const stack = new Int32Array(MAX_STACK);
  const mem = new Int32Array(MEMORY);
  const ret: number[] = [];
  const out = new Uint8Array(MAX_OUT);
  let sp = 0;
  let pc = 0;
  let steps = 0;
  let outLen = 0;
  let inPos = 0;

  function fail(code: number): never { throw new Trap(code); }

  function push(value: number): void {
    if (sp === MAX_STACK) fail(3);
    stack[sp++] = value | 0;
  }

  function pop(): number {
    if (sp === 0) fail(2);
    return stack[--sp];
  }

  // The two-operand instructions: division by zero traps 4, DIV
  // truncates toward zero, MOD takes the sign of a, shifts use the
  // low 5 bits of the count, U forms read operands as unsigned.
  function binary(op: number, a: number, b: number): number {
    switch (op) {
      case 0x10: return a + b;
      case 0x11: return a - b;
      case 0x12: return Math.imul(a, b);
      case 0x13: if (b === 0) fail(4); return Math.trunc(a / b);
      case 0x14: if (b === 0) fail(4); return a % b;
      case 0x15: if (b === 0) fail(4); return Math.floor((a >>> 0) / (b >>> 0));
      case 0x16: if (b === 0) fail(4); return (a >>> 0) % (b >>> 0);
      case 0x18: return a & b;
      case 0x19: return a | b;
      case 0x1a: return a ^ b;
      case 0x1c: return a << (b & 31);
      case 0x1d: return a >> (b & 31);
      case 0x1e: return a >>> (b & 31);
      case 0x20: return a === b ? 1 : 0;
      case 0x21: return a < b ? 1 : 0;
      default: return (a >>> 0) < (b >>> 0) ? 1 : 0;
    }
  }

  try {
    for (;;) {
      if (steps >= MAX_STEPS) fail(10);
      if (pc < 0 || pc >= prog.length) fail(9);
      const op = prog[pc];
      // Immediate bytes after the opcode: PUSH8 1, PUSH32 4, jumps 2.
      // Any other byte is an unknown opcode and traps 5 below.
      const imm = op === 0x01 ? 1 : op === 0x02 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
      if (imm > 0 && pc + imm >= prog.length) fail(9);
      steps++;
      const next = pc + 1 + imm;
      switch (op) {
        case 0x00: // HALT
          return { bytes: out.slice(0, outLen), code: 0 };
        case 0x01: {
          // PUSH8: a signed byte.
          const b = prog[pc + 1];
          push(b < 128 ? b : b - 256);
          break;
        }
        case 0x02: {
          // PUSH32: little-endian, signed.
          push(prog[pc + 1] | (prog[pc + 2] << 8) | (prog[pc + 3] << 16) | (prog[pc + 4] << 24));
          break;
        }
        case 0x03: // POP
          pop();
          break;
        case 0x04: { // DUP
          const a = pop();
          push(a);
          push(a);
          break;
        }
        case 0x05: { // SWAP
          const b = pop(), a = pop();
          push(b);
          push(a);
          break;
        }
        case 0x06: { // OVER
          const b = pop(), a = pop();
          push(a);
          push(b);
          push(a);
          break;
        }
        case 0x07: { // ROT: ( a b c -- b c a )
          const c = pop(), b = pop(), a = pop();
          push(b);
          push(c);
          push(a);
          break;
        }
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14:
        case 0x15: case 0x16: case 0x18: case 0x19: case 0x1a:
        case 0x1c: case 0x1d: case 0x1e: case 0x20: case 0x21:
        case 0x22: {
          const b = pop(), a = pop();
          push(binary(op, a, b));
          break;
        }
        case 0x17: // NEG
          push(-pop());
          break;
        case 0x1b: // NOT
          push(~pop());
          break;
        case 0x30: case 0x31: case 0x32: {
          // JMP, JZ, JNZ: a signed offset from the next instruction.
          const raw = prog[pc + 1] | (prog[pc + 2] << 8);
          const offset = raw < 32768 ? raw : raw - 65536;
          const take = op === 0x30 || (op === 0x31 ? pop() === 0 : pop() !== 0);
          if (take) {
            pc = next + offset;
            continue;
          }
          break;
        }
        case 0x33: {
          // CALL: an unsigned absolute address.
          if (ret.length === MAX_CALLS) fail(7);
          ret.push(next);
          pc = prog[pc + 1] | (prog[pc + 2] << 8);
          continue;
        }
        case 0x34: { // RET
          const target = ret.pop();
          if (target === undefined) fail(8);
          pc = target;
          continue;
        }
        case 0x40: { // LOAD
          const addr = pop();
          if (addr < 0 || addr >= MEMORY) fail(6);
          push(mem[addr]);
          break;
        }
        case 0x41: { // STORE: ( v addr -- ), the address is on top.
          const addr = pop();
          const v = pop();
          if (addr < 0 || addr >= MEMORY) fail(6);
          mem[addr] = v;
          break;
        }
        case 0x50: { // PRINT: the value in decimal ASCII.
          const text = String(pop());
          if (outLen + text.length > MAX_OUT) fail(11);
          for (let i = 0; i < text.length; i++) out[outLen++] = text.charCodeAt(i);
          break;
        }
        case 0x51: { // PUTC: one byte, the low 8 bits.
          const v = pop();
          if (outLen + 1 > MAX_OUT) fail(11);
          out[outLen++] = v & 0xff;
          break;
        }
        case 0x52: // IN: -1 past the end of the input.
          push(inPos < input.length ? input[inPos++] : -1);
          break;
        case 0x53: // EXIT: the low byte is the code.
          return { bytes: out.slice(0, outLen), code: pop() & 0xff };
        default:
          fail(5);
      }
      pc = next;
    }
  } catch (err) {
    if (err instanceof Trap) {
      return { bytes: out.slice(0, outLen), code: err.code };
    }
    throw err;
  }
}

function main(): void {
  // The harness names the mounts in the environment.
  const inRoot = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outRoot = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = readdirSync(inRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    const program = readFileSync(join(inRoot, id, "program.bin"));
    let input: Uint8Array = new Uint8Array(0);
    try { input = readFileSync(join(inRoot, id, "input.bin")); } catch { /* no input file: empty */ }
    const r = run(program, input);
    const dir = join(outRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stdout.bin"), r.bytes);
    writeFileSync(join(dir, "exit.txt"), String(r.code));
  }
}

main();
