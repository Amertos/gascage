/**
 * Assembler + program model. Functions are authored as labelled blocks; blocks
 * are what gas is charged against, so the assembler computes each block's cost
 * statically and records block boundaries in the flat instruction array.
 */
import { Op, type OpCode, instructionCost } from './isa';

export interface Instr {
  op: OpCode;
  a?: number;
  b?: number;
}

interface Pending {
  op: OpCode;
  a?: number;
  b?: number;
  label?: string;
}

export interface AsmFn {
  name: string;
  paramCount: number;
  localCount: number;
  code: Instr[];
  /** Start index in `code` of each block, in source order. */
  blockStarts: number[];
  /** Static gas cost per block (ENTER itself is free). */
  blockCosts: number[];
}

/** 1 MiB of 8-byte elements. The verifier refuses programs that can outgrow it. */
export const DEFAULT_ARENA_ELEMENTS = 131072;

export interface AsmProg {
  fns: AsmFn[];
  main: number;
  arenaElements: number;
}

export class FnBuilder {
  readonly name: string;
  readonly paramCount: number;
  private _localCount: number;
  private readonly blocks: { label: string; instrs: Pending[] }[];
  private current: { label: string; instrs: Pending[] };

  constructor(name: string, paramCount: number, localCount: number) {
    if (localCount < paramCount) throw new Error(`${name}: localCount < paramCount`);
    this.name = name;
    this.paramCount = paramCount;
    this._localCount = localCount;
    this.current = { label: 'entry', instrs: [] };
    this.blocks = [this.current];
  }

  get localCount(): number {
    return this._localCount;
  }

  /** The compiler discovers slots while lowering, so the frame grows on demand. */
  setLocalCount(n: number): void {
    if (n < this.paramCount) throw new Error(`${this.name}: ${n} slots < ${this.paramCount} params`);
    if (n > this._localCount) this._localCount = n;
  }

  /** Start a new basic block. Blocks are metering units, not just labels. */
  block(label: string): this {
    if (this.blocks.some((b) => b.label === label)) {
      throw new Error(`${this.name}: duplicate block label "${label}"`);
    }
    this.current = { label, instrs: [] };
    this.blocks.push(this.current);
    return this;
  }

  private emit(op: OpCode, a?: number, b?: number, label?: string): this {
    const p: Pending = { op };
    if (a !== undefined) p.a = a;
    if (b !== undefined) p.b = b;
    if (label !== undefined) p.label = label;
    this.current.instrs.push(p);
    return this;
  }

  const(v: number): this { return this.emit(Op.CONST, v); }
  load(slot: number): this { return this.emit(Op.LOADLOC, slot); }
  store(slot: number): this { return this.emit(Op.STORELOC, slot); }
  fadd(): this { return this.emit(Op.FADD); }
  fsub(): this { return this.emit(Op.FSUB); }
  fmul(): this { return this.emit(Op.FMUL); }
  fdiv(): this { return this.emit(Op.FDIV); }
  idiv(): this { return this.emit(Op.IDIV); }
  imod(): this { return this.emit(Op.IMOD); }
  ilt(): this { return this.emit(Op.ILT); }
  ile(): this { return this.emit(Op.ILE); }
  igt(): this { return this.emit(Op.IGT); }
  ige(): this { return this.emit(Op.IGE); }
  ieq(): this { return this.emit(Op.IEQ); }
  ine(): this { return this.emit(Op.INE); }
  jmp(label: string): this { return this.emit(Op.JMP, undefined, undefined, label); }
  jz(label: string): this { return this.emit(Op.JZ, undefined, undefined, label); }
  call(fnIndex: number, argc: number): this { return this.emit(Op.CALL, fnIndex, argc); }
  ret(): this { return this.emit(Op.RET); }
  halt(): this { return this.emit(Op.HALT); }
  arrayNew(elements: number): this { return this.emit(Op.ARRAY_NEW, elements); }
  arrayGet(): this { return this.emit(Op.ARRAY_GET); }
  arraySet(): this { return this.emit(Op.ARRAY_SET); }
  cast(to: number): this { return this.emit(Op.CAST, to); }
  sqrt(): this { return this.emit(Op.SQRT); }
  fabs(): this { return this.emit(Op.FABS); }
  fmin(): this { return this.emit(Op.FMIN); }
  fmax(): this { return this.emit(Op.FMAX); }
  iadd(mode: 32 | 64): this { return this.emit(Op.IADD, mode); }
  isub(mode: 32 | 64): this { return this.emit(Op.ISUB, mode); }
  imul(mode: 32 | 64): this { return this.emit(Op.IMUL, mode); }
  pop(): this { return this.emit(Op.POP); }

  assemble(): AsmFn {
    const starts = new Map<string, number>();
    let pc = 0;
    for (const b of this.blocks) {
      starts.set(b.label, pc);
      pc += 1 + b.instrs.length;
    }

    const code: Instr[] = [];
    const blockStarts: number[] = [];
    const blockCosts: number[] = [];

    for (const [i, b] of this.blocks.entries()) {
      blockStarts.push(code.length);
      code.push({ op: Op.ENTER, a: i });

      let cost = 0;
      for (const p of b.instrs) {
        cost += instructionCost(p.op, p.a);

        if (p.label !== undefined) {
          const target = starts.get(p.label);
          if (target === undefined) throw new Error(`${this.name}: unknown label "${p.label}"`);
          code.push({ op: p.op, a: target });
        } else if (p.a !== undefined && p.b !== undefined) {
          code.push({ op: p.op, a: p.a, b: p.b });
        } else if (p.a !== undefined) {
          code.push({ op: p.op, a: p.a });
        } else {
          code.push({ op: p.op });
        }
      }
      blockCosts.push(cost);
    }

    return {
      name: this.name,
      paramCount: this.paramCount,
      localCount: this.localCount,
      code,
      blockStarts,
      blockCosts,
    };
  }
}

export class Builder {
  private readonly fns: FnBuilder[] = [];

  fn(name: string, paramCount = 0, localCount = paramCount): FnBuilder {
    const f = new FnBuilder(name, paramCount, localCount);
    this.fns.push(f);
    return f;
  }

  /** Index a function will have at runtime; use it for CALL immediates. */
  indexOf(name: string): number {
    const i = this.fns.findIndex((f) => f.name === name);
    if (i < 0) throw new Error(`no such function: ${name}`);
    return i;
  }

  assemble(options: { main?: number; arenaElements?: number } = {}): AsmProg {
    const fns = this.fns.map((f) => f.assemble());
    const main = options.main ?? 0;
    if (fns[main] === undefined) throw new Error(`no main function at index ${main}`);
    return {
      fns,
      main,
      arenaElements: options.arenaElements ?? DEFAULT_ARENA_ELEMENTS,
    };
  }
}
