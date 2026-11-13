/**
 * Stack VM v0 with gas charged per basic block (spec §9).
 *
 * Invariants this file is responsible for:
 *  - gas accounting is a pure function of the instruction stream (every block's
 *    cost is static), so two engines agree on the exhaustion point;
 *  - every memory access is bounds-checked, because the source language has no
 *    way to express an unchecked one;
 *  - traps are fatal and reported, never thrown as JS exceptions, so a trap can
 *    never be mistaken for a host bug in a trace.
 */
import type { AsmFn, AsmProg } from './program';

export const Trap = {
  DivByZero: 'DivByZero',
  IndexOOB: 'IndexOOB',
  OutOfMemory: 'OutOfMemory',
  OutOfGas: 'OutOfGas',
  StackOverflow: 'StackOverflow',
  BadCast: 'BadCast',
  /** Integer overflow, or an integer operation on a non-integer (spec D6). */
  IntOverflow: 'IntOverflow',
  /** sqrt of a negative value (spec D4). */
  DomainError: 'DomainError',
  BadArrayLen: 'BadArrayLen',
  BadCall: 'BadCall',
  NoHalt: 'NoHalt',
} as const;

export type TrapKind = (typeof Trap)[keyof typeof Trap];

export interface RunOptions {
  gasLimit?: number;
  /** When false, ENTER does nothing: used only to measure metering overhead. */
  metering?: boolean;
  /** Called on every basic-block entry; the hook behind TraceRecorder (S4). */
  onBlock?: (fnIndex: number, blockIndex: number) => void;
}

export type RunResult =
  | { kind: 'ok'; value: number; gasUsed: number; blocks: number }
  | { kind: 'trap'; trap: TrapKind; gasUsed: number; blocks: number; pc: number };

/**
 * Handle packing: handle = ptr * HANDLE_BASE + len. Exact in f64 for 1 MiB
 * arenas. HANDLE_BASE is the modulus, so the longest permitted array is
 * HANDLE_BASE - 1; a length equal to the base would decode as the next ptr.
 */
const HANDLE_BASE = 4096;
const MAX_DEPTH = 64;
const STACK_SLOTS = 1024;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function isInt32(x: number): boolean {
  return Number.isInteger(x) && x >= INT32_MIN && x <= INT32_MAX;
}

interface Frame {
  fn: AsmFn;
  fnIndex: number;
  pc: number;
  locals: Float64Array;
  baseSp: number;
}

export function run(prog: AsmProg, args: readonly number[], opts: RunOptions = {}): RunResult {
  const gasLimit = opts.gasLimit ?? 1_000_000;
  const metering = opts.metering ?? true;

  const main = prog.fns[prog.main];
  if (main === undefined) throw new Error('program has no main function');
  if (args.length !== main.paramCount) {
    throw new Error(`main expects ${main.paramCount} args, got ${args.length}`);
  }

  const stack = new Float64Array(STACK_SLOTS);
  const arena = new Float64Array(prog.arenaElements);
  let arenaTop = 0;
  let sp = 0;

  let gasLeft = gasLimit;
  let gasUsed = 0;
  let blocks = 0;

  const mainLocals = new Float64Array(main.localCount);
  for (let i = 0; i < args.length; i++) mainLocals[i] = args[i] ?? 0;

  let fn: AsmFn = main;
  let fnIndex = prog.main;
  let locals: Float64Array = mainLocals;
  let pc = 0;
  let baseSp = 0;

  const frames: Frame[] = [];

  const fail = (trap: TrapKind): RunResult => ({
    kind: 'trap',
    trap,
    gasUsed: gasUsed + 1, // spec §9: a trap costs 1 and is charged before it is raised
    blocks,
    pc,
  });

  for (;;) {
    const ins = fn.code[pc];
    if (ins === undefined) return fail(Trap.NoHalt);

    switch (ins.op) {
      case 0: {
        // ENTER — the only place gas is charged.
        if (metering) {
          const cost = fn.blockCosts[ins.a ?? 0] ?? 0;
          if (gasLeft < cost) return fail(Trap.OutOfGas);
          gasLeft -= cost;
          gasUsed += cost;
        }
        blocks++;
        if (opts.onBlock !== undefined) opts.onBlock(fnIndex, ins.a ?? 0);
        pc++;
        break;
      }

      case 1: // CONST
        stack[sp++] = ins.a ?? 0;
        pc++;
        break;

      case 2: // LOADLOC
        stack[sp++] = locals[ins.a ?? 0] ?? 0;
        pc++;
        break;

      case 3: // STORELOC
        locals[ins.a ?? 0] = stack[--sp] ?? 0;
        pc++;
        break;

      case 4: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        stack[sp - 1] = a + b;
        pc++;
        break;
      }

      case 5: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        stack[sp - 1] = a - b;
        pc++;
        break;
      }

      case 6: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        stack[sp - 1] = a * b;
        pc++;
        break;
      }

      case 7: {
        const b = stack[--sp] ?? 0;
        if (b === 0) return fail(Trap.DivByZero); // spec D7: no inf, no NaN
        const a = stack[sp - 1] ?? 0;
        stack[sp - 1] = a / b;
        pc++;
        break;
      }

      case 8: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        if (b === 0) return fail(Trap.DivByZero);
        if (!isInt32(a) || !isInt32(b)) return fail(Trap.IntOverflow);
        const q = Math.trunc(a / b);
        if (!isInt32(q)) return fail(Trap.IntOverflow); // i32::MIN / -1
        stack[sp - 1] = q;
        pc++;
        break;
      }

      case 9: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        if (b === 0) return fail(Trap.DivByZero);
        if (!isInt32(a) || !isInt32(b)) return fail(Trap.IntOverflow);
        stack[sp - 1] = a - Math.trunc(a / b) * b;
        pc++;
        break;
      }

      case 10: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = (stack[sp - 1] ?? 0) < b ? 1 : 0;
        pc++;
        break;
      }

      case 11: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = (stack[sp - 1] ?? 0) <= b ? 1 : 0;
        pc++;
        break;
      }

      case 12: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = (stack[sp - 1] ?? 0) > b ? 1 : 0;
        pc++;
        break;
      }

      case 13: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = (stack[sp - 1] ?? 0) >= b ? 1 : 0;
        pc++;
        break;
      }

      case 14: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = (stack[sp - 1] ?? 0) === b ? 1 : 0;
        pc++;
        break;
      }

      case 15: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = (stack[sp - 1] ?? 0) !== b ? 1 : 0;
        pc++;
        break;
      }

      case 16: // JMP
        pc = ins.a ?? 0;
        break;

      case 17: {
        const v = stack[--sp] ?? 0;
        if (v === 0) pc = ins.a ?? 0;
        else pc++;
        break;
      }

      case 18: {
        const target = prog.fns[ins.a ?? 0];
        if (target === undefined) return fail(Trap.BadCall);
        const argc = ins.b ?? 0;
        if (argc !== target.paramCount) return fail(Trap.BadCall);
        if (frames.length >= MAX_DEPTH) return fail(Trap.StackOverflow);

        const calleeLocals = new Float64Array(target.localCount);
        for (let i = argc - 1; i >= 0; i--) calleeLocals[i] = stack[--sp] ?? 0;

        frames.push({ fn, fnIndex, pc: pc + 1, locals, baseSp });
        fn = target;
        fnIndex = ins.a ?? 0;
        locals = calleeLocals;
        baseSp = sp;
        pc = 0;
        break;
      }

      case 19: {
        const v = stack[--sp] ?? 0;
        sp = baseSp;
        stack[sp++] = v;
        const caller = frames.pop();
        if (caller === undefined) return { kind: 'ok', value: v, gasUsed, blocks };
        fn = caller.fn;
        fnIndex = caller.fnIndex;
        pc = caller.pc;
        locals = caller.locals;
        baseSp = caller.baseSp;
        break;
      }

      case 20: // HALT
        return { kind: 'ok', value: stack[sp - 1] ?? 0, gasUsed, blocks };

      case 21: {
        const n = ins.a ?? 0;
        if (!Number.isInteger(n) || n <= 0 || n >= HANDLE_BASE) return fail(Trap.BadArrayLen);
        if (arenaTop + n > arena.length) return fail(Trap.OutOfMemory);
        const handle = arenaTop * HANDLE_BASE + n;
        arenaTop += n;
        stack[sp++] = handle;
        pc++;
        break;
      }

      case 22: {
        const idx = stack[--sp] ?? 0;
        const h = stack[--sp] ?? 0;
        const ptr = Math.floor(h / HANDLE_BASE);
        const len = h % HANDLE_BASE;
        if (!Number.isInteger(idx) || idx < 0 || idx >= len) return fail(Trap.IndexOOB);
        stack[sp++] = arena[ptr + idx] ?? 0;
        pc++;
        break;
      }

      case 23: {
        const v = stack[--sp] ?? 0;
        const idx = stack[--sp] ?? 0;
        const h = stack[--sp] ?? 0;
        const ptr = Math.floor(h / HANDLE_BASE);
        const len = h % HANDLE_BASE;
        if (!Number.isInteger(idx) || idx < 0 || idx >= len) return fail(Trap.IndexOOB);
        arena[ptr + idx] = v;
        pc++;
        break;
      }

      case 24: {
        const to = ins.a ?? 0;
        const x = stack[sp - 1] ?? 0;
        if (to === 0) {
          if (!Number.isFinite(x)) return fail(Trap.BadCast);
          const t = Math.trunc(x);
          if (!isInt32(t)) return fail(Trap.BadCast);
          stack[sp - 1] = t;
        } else if (to === 1) {
          if (!Number.isFinite(x)) return fail(Trap.BadCast);
          const t = Math.trunc(x);
          if (Math.abs(t) > Number.MAX_SAFE_INTEGER) return fail(Trap.BadCast);
          stack[sp - 1] = t;
        }
        pc++;
        break;
      }

      case 25: {
        const x = stack[sp - 1] ?? 0;
        if (x < 0) return fail(Trap.DomainError); // spec D4: no NaN from sqrt
        stack[sp - 1] = Math.sqrt(x);
        pc++;
        break;
      }

      case 26: {
        const x = stack[sp - 1] ?? 0;
        stack[sp - 1] = Math.abs(x);
        pc++;
        break;
      }

      case 27: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = Math.min(stack[sp - 1] ?? 0, b);
        pc++;
        break;
      }

      case 28: {
        const b = stack[--sp] ?? 0;
        stack[sp - 1] = Math.max(stack[sp - 1] ?? 0, b);
        pc++;
        break;
      }

      case 29: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        const r = a + b;
        if (!integerFits(a, b, r, ins.a)) return fail(Trap.IntOverflow);
        stack[sp - 1] = r;
        pc++;
        break;
      }

      case 30: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        const r = a - b;
        if (!integerFits(a, b, r, ins.a)) return fail(Trap.IntOverflow);
        stack[sp - 1] = r;
        pc++;
        break;
      }

      case 31: {
        const b = stack[--sp] ?? 0;
        const a = stack[sp - 1] ?? 0;
        const r = a * b;
        if (!integerFits(a, b, r, ins.a)) return fail(Trap.IntOverflow);
        stack[sp - 1] = r;
        pc++;
        break;
      }

      case 32: // POP
        sp--;
        pc++;
        break;

      default:
        return fail(Trap.NoHalt);
    }
  }
}

/**
 * Integer arithmetic is checked against the width the compiler chose: i32 means
 * 32 bits, i64 means the largest exactly-representable f64 integer.
 */
function integerFits(a: number, b: number, r: number, mode: number | undefined): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(r)) return false;
  if (mode === 64) return Math.abs(a) <= Number.MAX_SAFE_INTEGER && Math.abs(r) <= Number.MAX_SAFE_INTEGER;
  return isInt32(a) && isInt32(b) && isInt32(r);
}
