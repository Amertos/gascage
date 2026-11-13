/**
 * Typechecker + the v0.1 static analyses. Everything here runs before a single
 * instruction executes; the S5 verifier replaces the loop/index analyses with
 * SMT-backed ones, but the diagnostic codes are already fixed by the spec.
 */
import { GsError } from './diagnostics';
import type { BinOp, Expr, FnDecl, Module, Stmt, Type } from './ast';
import { T, isIntegerType, isNumeric, typeEq, typeName } from './ast';

export interface FnInfo {
  name: string;
  index: number;
  params: Type[];
  ret: Type;
  decl: FnDecl;
}

const BUILTINS = new Map<string, { params: Type[]; ret: Type }>([
  ['sqrt', { params: [T.f64], ret: T.f64 }],
  ['abs', { params: [T.f64], ret: T.f64 }],
  ['min', { params: [T.f64, T.f64], ret: T.f64 }],
  ['max', { params: [T.f64, T.f64], ret: T.f64 }],
]);

const CASTS: Record<string, string[]> = {
  i32: ['i32', 'i64', 'f64'],
  i64: ['i64', 'i32', 'f64'],
  f64: ['f64', 'i32', 'i64'],
};

const COMPARISONS = new Set<BinOp>(['<', '<=', '>', '>=', '==', '!=']);

class ScopeStack {
  private readonly frames: { name: string; type: Type }[][] = [];

  push(): void {
    this.frames.push([]);
  }

  pop(): void {
    if (this.frames.length === 0) throw new Error('scope underflow');
    this.frames.pop();
  }

  declare(name: string, type: Type, pos: number): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) throw new Error('no scope');
    if (frame.some((b) => b.name === name)) {
      throw new GsError('E_SCOPE', `"${name}" is already declared in this block`, pos);
    }
    frame.push({ name, type });
  }

  lookup(name: string): Type | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const found = this.frames[i]!.find((b) => b.name === name);
      if (found !== undefined) return found.type;
    }
    return null;
  }
}

class Checker {
  private readonly byName = new Map<string, FnInfo>();
  private fn: FnDecl = { name: '', params: [], ret: T.unit, body: [], pos: 0 };

  constructor(private readonly mod: Module) {}

  run(): FnInfo[] {
    const infos: FnInfo[] = [];

    for (const [index, decl] of this.mod.fns.entries()) {
      if (this.byName.has(decl.name) || BUILTINS.has(decl.name)) {
        throw new GsError('E_SCOPE', `function "${decl.name}" is already defined`, decl.pos);
      }
      const info: FnInfo = {
        name: decl.name,
        index,
        params: decl.params.map((p) => p.type),
        ret: decl.ret,
        decl,
      };
      this.byName.set(decl.name, info);
      infos.push(info);
    }

    for (const info of infos) this.checkFn(info);
    this.checkRecursion();

    return infos;
  }

  // ---- functions ---------------------------------------------------------

  private checkFn(info: FnInfo): void {
    const decl = info.decl;
    this.fn = decl;

    const scope = new ScopeStack();
    scope.push();
    for (const p of decl.params) scope.declare(p.name, p.type, p.pos);

    this.checkStmts(decl.body, scope);

    if (decl.ret.kind !== 'unit' && !alwaysReturns(decl.body)) {
      throw new GsError(
        'E_MISSING_RETURN',
        `"${decl.name}" can finish without returning ${typeName(decl.ret)}`,
        decl.pos,
      );
    }
  }

  private checkStmts(stmts: Stmt[], scope: ScopeStack): void {
    for (const s of stmts) this.checkStmt(s, scope);
  }

  private checkStmt(s: Stmt, scope: ScopeStack): void {
    switch (s.kind) {
      case 'let': {
        const t = this.checkExpr(s.init, s.type, scope);
        if (!typeEq(t, s.type)) {
          throw new GsError(
            'E_TYPE_MISMATCH',
            `cannot initialise ${typeName(s.type)} from ${typeName(t)}`,
            s.pos,
          );
        }
        scope.declare(s.name, s.type, s.pos);
        return;
      }
      case 'set': {
        const t = scope.lookup(s.name);
        if (t === null) throw new GsError('E_SCOPE', `"${s.name}" is not declared`, s.pos);
        this.checkExpr(s.value, t, scope);
        return;
      }
      case 'if': {
        this.checkExpr(s.cond, T.bool, scope);
        scope.push();
        this.checkStmts(s.then, scope);
        scope.pop();
        if (s.els !== null) {
          scope.push();
          this.checkStmts(s.els, scope);
          scope.pop();
        }
        return;
      }
      case 'while': {
        this.checkExpr(s.cond, T.bool, scope);
        scope.push();
        this.checkStmts(s.body, scope);
        scope.pop();
        requireLoopBound(s);
        return;
      }
      case 'return': {
        if (this.fn.ret.kind === 'unit') {
          if (s.value !== null) {
            throw new GsError('E_TYPE_MISMATCH', 'a unit function cannot return a value', s.pos);
          }
          return;
        }
        if (s.value === null) {
          throw new GsError(
            'E_TYPE_MISMATCH',
            `return needs a ${typeName(this.fn.ret)} value`,
            s.pos,
          );
        }
        this.checkExpr(s.value, this.fn.ret, scope);
        return;
      }
      case 'expr': {
        const t = this.checkExpr(s.expr, null, scope);
        if (t.kind === 'array' || t.kind === 'unit') return;
        return;
      }
    }
  }

  // ---- expressions -------------------------------------------------------

  private checkExpr(e: Expr, expected: Type | null, scope: ScopeStack): Type {
    const t = this.infer(e, expected, scope);
    e.type = t;

    if (expected !== null && !typeEq(t, expected)) {
      throw new GsError(
        'E_TYPE_MISMATCH',
        `expected ${typeName(expected)} but found ${typeName(t)}`,
        e.pos,
      );
    }
    return t;
  }

  private infer(e: Expr, expected: Type | null, scope: ScopeStack): Type {
    switch (e.kind) {
      case 'num': {
        // A bare integer is context-typed; a float is always f64.
        const t: Type = e.isFloat ? T.f64 : expected !== null && isNumeric(expected) ? expected : T.i32;
        if (expected !== null && !typeEq(t, expected)) return t; // caller reports the mismatch
        return t;
      }
      case 'bool':
        return T.bool;

      case 'var': {
        const t = scope.lookup(e.name);
        if (t === null) throw new GsError('E_SCOPE', `"${e.name}" is not declared`, e.pos);
        return t;
      }

      case 'un': {
        if (e.op === '!') {
          this.checkExpr(e.expr, T.bool, scope);
          return T.bool;
        }
        const want = expected !== null && isNumeric(expected) ? expected : null;
        const t = this.checkExpr(e.expr, want, scope);
        if (!isNumeric(t)) {
          throw new GsError('E_TYPE_MISMATCH', `cannot negate ${typeName(t)}`, e.pos);
        }
        return t;
      }

      case 'cast': {
        const from = this.checkExpr(e.expr, null, scope);
        if (!isNumeric(from) || !isNumeric(e.to)) {
          throw new GsError(
            'E_TYPE_MISMATCH',
            `cannot cast ${typeName(from)} to ${typeName(e.to)}`,
            e.pos,
          );
        }
        const allowed = CASTS[from.kind] ?? [];
        if (!allowed.includes(e.to.kind)) {
          throw new GsError(
            'E_TYPE_MISMATCH',
            `cannot cast ${typeName(from)} to ${typeName(e.to)}`,
            e.pos,
          );
        }
        return e.to;
      }

      case 'bin':
        return this.checkBin(e, expected, scope);

      case 'call': {
        const builtin = BUILTINS.get(e.name);
        if (builtin !== undefined) {
          if (e.args.length !== builtin.params.length) {
            throw new GsError(
              'E_ARITY',
              `${e.name} takes ${builtin.params.length} argument(s), got ${e.args.length}`,
              e.pos,
            );
          }
          e.args.forEach((a, i) => this.checkExpr(a, builtin.params[i]!, scope));
          return builtin.ret;
        }

        const info = this.byName.get(e.name);
        if (info === undefined) {
          throw new GsError('E_SCOPE', `no such function "${e.name}"`, e.pos);
        }
        if (e.args.length !== info.params.length) {
          throw new GsError(
            'E_ARITY',
            `${e.name} takes ${info.params.length} argument(s), got ${e.args.length}`,
            e.pos,
          );
        }
        e.args.forEach((a, i) => this.checkExpr(a, info.params[i]!, scope));
        return info.ret;
      }

      case 'index': {
        const target = this.checkExpr(e.target, null, scope);
        if (target.kind !== 'array') {
          throw new GsError('E_TYPE_MISMATCH', `cannot index ${typeName(target)}`, e.pos);
        }
        const idx = this.checkExpr(e.index, null, scope);
        if (!isIntegerType(idx)) {
          throw new GsError('E_INDEX_TYPE', `array index must be an integer, got ${typeName(idx)}`, e.pos);
        }
        if (e.index.kind === 'num' && !e.index.isFloat) {
          const v = e.index.value;
          if (!Number.isInteger(v) || v < 0 || v >= target.len) {
            throw new GsError(
              'E_INDEX_OOB',
              `index ${v} is outside [0, ${target.len})`,
              e.pos,
            );
          }
        }
        return target.elem;
      }

      case 'arrayLit': {
        if (expected !== null) {
          if (expected.kind !== 'array') {
            throw new GsError('E_TYPE_MISMATCH', `expected ${typeName(expected)} for an array literal`, e.pos);
          }
          if (e.elems.length !== expected.len) {
            throw new GsError(
              'E_ARRAY_SIZE',
              `array literal has ${e.elems.length} element(s) but ${expected.len} expected`,
              e.pos,
            );
          }
          for (const el of e.elems) this.checkExpr(el, expected.elem, scope);
          return expected;
        }
        const first = e.elems[0];
        if (first === undefined) throw new GsError('E_UNSUPPORTED', 'empty array literals need a type', e.pos);
        const elem = this.checkExpr(first, null, scope);
        for (const el of e.elems.slice(1)) this.checkExpr(el, elem, scope);
        return { kind: 'array', elem, len: e.elems.length };
      }

      case 'arrayRepeat': {
        if (expected !== null) {
          if (expected.kind !== 'array') {
            throw new GsError('E_TYPE_MISMATCH', `expected ${typeName(expected)} for an array literal`, e.pos);
          }
          if (e.len !== expected.len) {
            throw new GsError(
              'E_ARRAY_SIZE',
              `repeat literal has length ${e.len} but ${expected.len} expected`,
              e.pos,
            );
          }
          this.checkExpr(e.value, expected.elem, scope);
          return expected;
        }
        const elem = this.checkExpr(e.value, null, scope);
        return { kind: 'array', elem, len: e.len };
      }
    }
  }

  private checkBin(e: Extract<Expr, { kind: 'bin' }>, expected: Type | null, scope: ScopeStack): Type {
    if (e.op === '&&' || e.op === '||') {
      this.checkExpr(e.left, T.bool, scope);
      this.checkExpr(e.right, T.bool, scope);
      return T.bool;
    }

    if ((e.op === '/' || e.op === '%') && e.right.kind === 'num' && e.right.value === 0) {
      throw new GsError('E_DIV_BY_ZERO', 'division by the literal zero', e.pos);
    }

    const want = expected !== null && isNumeric(expected) ? expected : null;
    const lt = this.checkExpr(e.left, want, scope);
    if (!isNumeric(lt)) {
      throw new GsError('E_TYPE_MISMATCH', `cannot apply "${e.op}" to ${typeName(lt)}`, e.pos);
    }

    const rt = this.checkExpr(e.right, lt, scope);
    if (!typeEq(lt, rt)) {
      throw new GsError(
        'E_TYPE_MISMATCH',
        `"${e.op}" mixes ${typeName(lt)} and ${typeName(rt)}`,
        e.pos,
      );
    }

    if (e.op === '%' && lt.kind === 'f64') {
      throw new GsError('E_TYPE_MISMATCH', '"%" is defined for integers only', e.pos);
    }

    return COMPARISONS.has(e.op) ? T.bool : lt;
  }

  // ---- interprocedural ---------------------------------------------------

  private checkRecursion(): void {
    const color = new Map<string, 0 | 1 | 2>();
    for (const name of this.byName.keys()) color.set(name, 0);

    const visit = (name: string, stack: string[]): void => {
      const state = color.get(name);
      if (state === 1) {
        const cycle = [...stack.slice(stack.indexOf(name)), name].join(' -> ');
        throw new GsError('E_RECURSION', `recursion is not allowed in v0.1: ${cycle}`, 0);
      }
      if (state === 2) return;
      color.set(name, 1);
      const info = this.byName.get(name);
      if (info !== undefined) {
        for (const callee of calleesOf(info.decl)) {
          if (callee === name) {
            throw new GsError(
              'E_RECURSION',
              `recursion is not allowed in v0.1: ${name} calls itself`,
              info.decl.pos,
            );
          }
          if (this.byName.has(callee)) visit(callee, [...stack, name]);
        }
      }
      color.set(name, 2);
    };

    for (const name of this.byName.keys()) visit(name, []);
  }
}

// ---- helpers -------------------------------------------------------------

function alwaysReturns(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === 'return') return true;
    if (s.kind === 'if' && s.els !== null && alwaysReturns(s.then) && alwaysReturns(s.els)) {
      return true;
    }
  }
  return false;
}

function calleesOf(fn: FnDecl): string[] {
  const out: string[] = [];
  const walkExpr = (e: Expr): void => {
    switch (e.kind) {
      case 'call':
        out.push(e.name);
        e.args.forEach(walkExpr);
        return;
      case 'bin':
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case 'un':
        walkExpr(e.expr);
        return;
      case 'index':
        walkExpr(e.target);
        walkExpr(e.index);
        return;
      case 'cast':
        walkExpr(e.expr);
        return;
      case 'arrayLit':
        e.elems.forEach(walkExpr);
        return;
      case 'arrayRepeat':
        walkExpr(e.value);
        return;
      default:
        return;
    }
  };
  const walkStmts = (list: Stmt[]): void => {
    for (const s of list) {
      switch (s.kind) {
        case 'let':
          walkExpr(s.init);
          break;
        case 'set':
          walkExpr(s.value);
          break;
        case 'if':
          walkExpr(s.cond);
          walkStmts(s.then);
          if (s.els !== null) walkStmts(s.els);
          break;
        case 'while':
          walkExpr(s.cond);
          walkStmts(s.body);
          break;
        case 'return':
          if (s.value !== null) walkExpr(s.value);
          break;
        case 'expr':
          walkExpr(s.expr);
          break;
      }
    }
  };
  walkStmts(fn.body);
  return out;
}

/**
 * v0.1 loop bound: `while v < K` (or `> K`) where the body steps `v` by a
 * literal in the correct direction. Conservative on purpose — S5 replaces it
 * with size-change/SMT reasoning, and anything unproven is rejected, never run.
 */
function requireLoopBound(w: Extract<Stmt, { kind: 'while' }>): void {
  const reject = (why: string): never => {
    throw new GsError('E_UNBOUNDED_LOOP', `no provable bound: ${why}`, w.pos);
  };

  const c = w.cond;
  if (c.kind !== 'bin') return reject('the condition is not a comparison');

  let name = '';
  let dir: 1 | -1 = 1;

  // The limit may be any expression: termination only needs the step direction,
  // while the *numeric* bound (and therefore the gas proof) is the verifier's job.
  if (c.left.kind === 'var') {
    name = c.left.name;
    if (c.op === '<' || c.op === '<=') dir = 1;
    else if (c.op === '>' || c.op === '>=') dir = -1;
    else return reject('the condition must order a variable against a limit');
  } else if (c.left.kind === 'num' && c.right.kind === 'var') {
    name = c.right.name;
    if (c.op === '<' || c.op === '<=') dir = -1;
    else if (c.op === '>' || c.op === '>=') dir = 1;
    else return reject('the condition must order a variable against a constant');
  } else {
    return reject('the condition must compare a variable with a constant');
  }

  if (!stepsInDirection(w.body, name, dir)) {
    return reject(`"${name}" is not stepped by a constant towards the exit in the body`);
  }
}

function stepsInDirection(stmts: Stmt[], name: string, dir: 1 | -1): boolean {
  for (const s of stmts) {
    if (s.kind === 'set' && s.name === name) {
      const v = s.value;
      if (v.kind === 'bin' && (v.op === '+' || v.op === '-')) {
        const step = v.op === '+' ? 1 : -1;
        const literal =
          (v.left.kind === 'var' && v.left.name === name && v.right.kind === 'num') ||
          (v.op === '+' && v.right.kind === 'var' && v.right.name === name && v.left.kind === 'num');
        if (literal && step === dir && (v.right.kind === 'num' || v.left.kind === 'num')) return true;
      }
    }
    if (s.kind === 'if' && (stepsInDirection(s.then, name, dir) || (s.els !== null && stepsInDirection(s.els, name, dir)))) {
      return true;
    }
    if (s.kind === 'while' && stepsInDirection(s.body, name, dir)) return true;
  }
  return false;
}

export function checkModule(mod: Module): FnInfo[] {
  return new Checker(mod).run();
}
