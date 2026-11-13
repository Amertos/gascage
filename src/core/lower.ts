/**
 * Lowering: typed AST → bytecode. The typechecker has already annotated every
 * expression (`e.type`), so this pass only chooses opcodes and lays out blocks.
 */
import type { BinOp, Expr, FnDecl, Stmt, Type } from './ast';
import { isIntegerType } from './ast';
import type { FnInfo } from './check';
import { Builder, type FnBuilder } from './program';

const BUILTIN_OPS: Record<string, 'sqrt' | 'fabs' | 'fmin' | 'fmax'> = {
  sqrt: 'sqrt',
  abs: 'fabs',
  min: 'fmin',
  max: 'fmax',
};

interface Binding {
  slot: number;
  type: Type;
}

class FnLowerer {
  private readonly f: FnBuilder;
  private slots: number;
  private readonly scopes: Map<string, Binding>[] = [];
  private labelSeq = 0;

  constructor(
    builder: Builder,
    private readonly decl: FnDecl,
    private readonly indexOf: (name: string) => number,
  ) {
    this.f = builder.fn(decl.name, decl.params.length, decl.params.length);
    this.slots = decl.params.length;
  }

  run(): void {
    this.pushScope();
    this.decl.params.forEach((p, i) => this.bind(p.name, { slot: i, type: p.type }));

    this.stmts(this.decl.body);

    // Its own block, because gas is charged per block entry: when the checker
    // proved that every path returns, this tail must cost exactly nothing. If it
    // shared a block with the final `return`, the VM would charge it anyway.
    this.f.block(this.label('fn_end'));
    this.f.const(0).ret();
    this.f.setLocalCount(this.slots);
    this.popScope();
  }

  // ---- scopes ------------------------------------------------------------

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private bind(name: string, b: Binding): void {
    const frame = this.scopes[this.scopes.length - 1];
    if (frame === undefined) throw new Error('no scope');
    frame.set(name, b);
  }

  private lookup(name: string): Binding {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found !== undefined) return found;
    }
    throw new Error(`internal: unbounded name ${name}`);
  }

  private label(prefix: string): string {
    this.labelSeq += 1;
    return `${prefix}_${this.labelSeq}`;
  }

  private ty(e: Expr): Type {
    if (e.type === undefined) throw new Error('internal: expression was not typed');
    return e.type;
  }

  // ---- statements --------------------------------------------------------

  private stmts(list: Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: Stmt): void {
    switch (s.kind) {
      case 'let': {
        this.expr(s.init);
        const slot = this.slots++;
        this.bind(s.name, { slot, type: s.type });
        this.f.store(slot);
        return;
      }
      case 'set': {
        this.expr(s.value);
        this.f.store(this.lookup(s.name).slot);
        return;
      }
      case 'if': {
        const lElse = this.label('else');
        const lThen = this.label('then');
        this.expr(s.cond);
        this.f.jz(lElse);

        // The then-arm is its own block: gas is charged per block entry, so a
        // block must never contain instructions from two different paths.
        this.f.block(lThen);
        this.pushScope();
        this.stmts(s.then);
        this.popScope();

        if (s.els !== null) {
          const lEnd = this.label('endif');
          this.f.jmp(lEnd);
          this.f.block(lElse);
          this.pushScope();
          this.stmts(s.els);
          this.popScope();
          this.f.block(lEnd);
        } else {
          this.f.block(lElse);
        }
        return;
      }
      case 'while': {
        const lCond = this.label('while');
        const lBody = this.label('wbody');
        const lEnd = this.label('wend');
        this.f.jmp(lCond);
        this.f.block(lCond);
        this.expr(s.cond);
        this.f.jz(lEnd);
        // Same rule as the if-arm: the body gets a block of its own.
        this.f.block(lBody);
        this.pushScope();
        this.stmts(s.body);
        this.popScope();
        this.f.jmp(lCond);
        this.f.block(lEnd);
        return;
      }
      case 'return': {
        if (s.value !== null) this.expr(s.value);
        else this.f.const(0);
        this.f.ret();
        return;
      }
      case 'expr': {
        this.expr(s.expr);
        this.f.pop();
        return;
      }
    }
  }

  // ---- expressions -------------------------------------------------------

  private expr(e: Expr): void {
    switch (e.kind) {
      case 'num':
        this.f.const(e.value);
        return;
      case 'bool':
        this.f.const(e.value ? 1 : 0);
        return;
      case 'var':
        this.f.load(this.lookup(e.name).slot);
        return;

      case 'un':
        if (e.op === '-') {
          this.f.const(0);
          this.expr(e.expr);
          this.arith('-', this.ty(e));
        } else {
          this.expr(e.expr);
          this.f.const(0);
          this.f.ieq();
        }
        return;

      case 'bin':
        this.bin(e);
        return;

      case 'cast': {
        this.expr(e.expr);
        const code = e.to.kind === 'i32' ? 0 : e.to.kind === 'i64' ? 1 : 2;
        this.f.cast(code);
        return;
      }

      case 'call': {
        const builtin = BUILTIN_OPS[e.name];
        if (builtin !== undefined) {
          for (const a of e.args) this.expr(a);
          if (builtin === 'sqrt') this.f.sqrt();
          else if (builtin === 'fabs') this.f.fabs();
          else if (builtin === 'fmin') this.f.fmin();
          else this.f.fmax();
          return;
        }
        for (const a of e.args) this.expr(a);
        this.f.call(this.indexOf(e.name), e.args.length);
        return;
      }

      case 'index': {
        this.expr(e.target);
        this.expr(e.index);
        this.f.arrayGet();
        return;
      }

      case 'arrayLit': {
        const n = e.elems.length;
        const tmp = this.slots++;
        this.f.arrayNew(n).store(tmp);
        for (const [i, el] of e.elems.entries()) {
          this.f.load(tmp).const(i);
          this.expr(el);
          this.f.arraySet();
        }
        this.f.load(tmp);
        return;
      }

      case 'arrayRepeat': {
        const tmpH = this.slots++;
        const tmpI = this.slots++;
        this.f.arrayNew(e.len).store(tmpH);
        this.f.const(0).store(tmpI);

        const lLoop = this.label('fill');
        const lDone = this.label('filled');
        this.f.jmp(lLoop);
        this.f.block(lLoop);
        this.f.load(tmpI).const(e.len).ilt().jz(lDone);
        this.f.load(tmpH).load(tmpI);
        this.expr(e.value);
        this.f.arraySet();
        this.f.load(tmpI).const(1).fadd().store(tmpI);
        this.f.jmp(lLoop);
        this.f.block(lDone);
        this.f.load(tmpH);
        return;
      }
    }
  }

  private bin(e: Extract<Expr, { kind: 'bin' }>): void {
    if (e.op === '&&') {
      const lFalse = this.label('and_false');
      const lEnd = this.label('and_end');
      this.expr(e.left);
      this.f.jz(lFalse);
      this.expr(e.right);
      this.f.jz(lFalse);
      this.f.const(1);
      this.f.jmp(lEnd);
      this.f.block(lFalse);
      this.f.const(0);
      this.f.block(lEnd);
      return;
    }

    if (e.op === '||') {
      const lRight = this.label('or_right');
      const lFalse = this.label('or_false');
      const lEnd = this.label('or_end');
      this.expr(e.left);
      this.f.jz(lRight);
      this.f.const(1);
      this.f.jmp(lEnd);
      this.f.block(lRight);
      this.expr(e.right);
      this.f.jz(lFalse);
      this.f.const(1);
      this.f.jmp(lEnd);
      this.f.block(lFalse);
      this.f.const(0);
      this.f.block(lEnd);
      return;
    }

    this.expr(e.left);
    this.expr(e.right);

    switch (e.op) {
      case '<':
        this.f.ilt();
        return;
      case '<=':
        this.f.ile();
        return;
      case '>':
        this.f.igt();
        return;
      case '>=':
        this.f.ige();
        return;
      case '==':
        this.f.ieq();
        return;
      case '!=':
        this.f.ine();
        return;
      default:
        this.arith(e.op, this.ty(e));
    }
  }

  private arith(op: BinOp, t: Type): void {
    if (isIntegerType(t)) {
      const mode = t.kind === 'i32' ? 32 : 64;
      switch (op) {
        case '+':
          this.f.iadd(mode);
          return;
        case '-':
          this.f.isub(mode);
          return;
        case '*':
          this.f.imul(mode);
          return;
        case '/':
          this.f.idiv();
          return;
        case '%':
          this.f.imod();
          return;
        default:
          throw new Error(`internal: ${op} is not arithmetic`);
      }
    }

    switch (op) {
      case '+':
        this.f.fadd();
        return;
      case '-':
        this.f.fsub();
        return;
      case '*':
        this.f.fmul();
        return;
      case '/':
        this.f.fdiv();
        return;
      default:
        throw new Error(`internal: ${op} is not arithmetic on f64`);
    }
  }
}

export function lower(infos: FnInfo[]): { builder: Builder } {
  const builder = new Builder();
  const indexByName = new Map(infos.map((f) => [f.name, f.index]));

  for (const info of infos) {
    const lowerer = new FnLowerer(builder, info.decl, (name) => {
      const i = indexByName.get(name);
      if (i === undefined) throw new Error(`internal: unknown callee ${name}`);
      return i;
    });
    lowerer.run();
  }

  return { builder };
}
