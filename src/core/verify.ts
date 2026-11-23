/**
 * The verifier (S5). It walks the typed AST and computes, before execution:
 *
 *   - a gas bound, as a linear form over the function's parameters;
 *   - a memory bound, in bytes.
 *
 * The bound mirrors the lowering in `lower.ts` instruction for instruction. That
 * correspondence is not assumed: `tests/verify.test.mjs` runs every accepted
 * program with the proven bound as its *only* gas budget, so a single undercount
 * traps with OutOfGas and fails the build.
 *
 * Rejection is the default: a loop whose trip count cannot be expressed is
 * refused with E_GAS_UNBOUNDED instead of being run under a timer.
 */
import type { Expr, FnDecl, Stmt, Type } from './ast';
import { isIntegerType } from './ast';
import { checkModule, type FnInfo } from './check';
import * as C from './cost';
import { GsError, type DiagnosticCode } from './diagnostics';
import { parse } from './parser';
import { DEFAULT_ARENA_ELEMENTS } from './program';
import { loopVariant, type Variant } from './variant';

const ELEMENT_BYTES = 8;
const ARENA_BYTES = DEFAULT_ARENA_ELEMENTS * ELEMENT_BYTES;

interface Sig {
  params: string[];
  cost: C.Form;
  mem: C.Form;
}

interface Range {
  lo: number;
  hi: number;
}

type Val = { k: 'const'; v: number } | { k: 'param'; name: string } | { k: 'unknown' };

type Env = Map<string, Val>;

interface Sum {
  cost: C.Form;
  mem: C.Form;
}

export interface Certificate {
  fn: string;
  gas: C.Form;
  memoryBytes: C.Form;
  loops: { at: number; iters: C.Form }[];
  obligations: string[];
}

export type VerifyResult =
  | { ok: true; certs: Certificate[] }
  | { ok: false; code: DiagnosticCode; detail: string };

interface Ctx {
  sigs: Map<string, Sig>;
  loops: { at: number; iters: C.Form }[];
  /** Proven ranges of induction variables, innermost frame last. */
  ranges: Map<string, Range>[];
}

const sZero = (): Sum => ({ cost: C.zero(), mem: C.zero() });
const constSum = (cost: number, mem = 0): Sum => ({ cost: C.constForm(cost), mem: C.constForm(mem) });
const sAdd = (a: Sum, b: Sum): Sum => ({ cost: C.add(a.cost, b.cost), mem: C.add(a.mem, b.mem) });

// ---- value tracking -------------------------------------------------------

function evalVal(e: Expr, env: Env): Val {
  if (e.kind === 'num') return { k: 'const', v: e.value };
  if (e.kind === 'var') return env.get(e.name) ?? { k: 'unknown' };
  return { k: 'unknown' };
}

function assignedNames(stmts: Stmt[], into = new Set<string>()): Set<string> {
  for (const s of stmts) {
    if (s.kind === 'let' || s.kind === 'set') into.add(s.name);
    if (s.kind === 'if') {
      assignedNames(s.then, into);
      if (s.els !== null) assignedNames(s.els, into);
    }
    if (s.kind === 'while') assignedNames(s.body, into);
  }
  return into;
}

function invalidate(env: Env, names: Set<string>): void {
  for (const n of names) env.set(n, { k: 'unknown' });
}

// ---- loop trip counts -----------------------------------------------------

function loopInfo(
  cond: Expr,
  body: Stmt[],
  env: Env,
): { iters: C.Form; variant: Variant } {
  const bad = (why: string): never => {
    throw new GsError('E_GAS_UNBOUNDED', `cannot bound loop: ${why}`, cond.pos);
  };

  // The step rule is shared with the checker: one analysis, one answer.
  const result = loopVariant(cond, body);
  if (!result.ok) return bad(result.why);
  const variant = result.variant;

  const name = variant.name;
  const step = Math.abs(variant.delta);
  const inclusive = variant.inclusive;

  const cnt = env.get(name) ?? { k: 'unknown' };
  if (cnt.k !== 'const') return bad(`"${name}" is not initialised to a constant`);

  const lim = evalVal(variant.limit, env);

  if (variant.ascending) {
    if (lim.k === 'const') {
      const span = lim.v - cnt.v;
      if (span < 0) return { iters: C.constForm(0), variant };
      const k = inclusive
        ? Math.max(0, Math.floor(span / step) + 1)
        : Math.max(0, Math.ceil(span / step));
      return { iters: C.constForm(k), variant };
    }
    if (lim.k === 'param') {
      // Sound over-approximation for any real value of the parameter: p/step + 1.
      const terms = new Map<string, number>([[lim.name, 1 / step]]);
      return { iters: { base: 1 + Math.max(0, -cnt.v / step), terms }, variant };
    }
    return bad('the limit is neither a constant nor a parameter');
  }

  if (lim.k !== 'const') return bad('a descending loop must end at a constant');
  const span = cnt.v - lim.v;
  if (span < 0) return { iters: C.constForm(0), variant };
  const k = inclusive
    ? Math.max(0, Math.floor(span / step) + 1)
    : Math.max(0, Math.ceil(span / step));
  return { iters: C.constForm(k), variant };
}

/** Range the counter provably takes inside the loop body, or null. */
function rangeFor(variant: Variant, env: Env): Range | null {
  const start = env.get(variant.name);
  const lim = evalVal(variant.limit, env);
  if (start === undefined || start.k !== 'const' || lim.k !== 'const') return null;

  const range = variant.ascending
    ? {
        lo: start.v,
        hi: variant.inclusive ? lim.v : lim.v - 1,
      }
    : {
        lo: variant.inclusive ? lim.v : lim.v + 1,
        hi: start.v,
      };

  return range.lo <= range.hi ? range : null;
}

// ---- value forms ----------------------------------------------------------

/**
 * A non-negative linear form that bounds the value of `e` from above.
 *
 * Used to rebind a callee's cost form at the call site. Anything not expressible
 * here returns null, and the call is refused `E_GAS_UNBOUNDED`: a caller whose
 * argument cost could not be expressed would otherwise inherit a bound that is
 * silently short.
 */
function valueForm(e: Expr, env: Env, ctx: Ctx): C.Form | null {
  switch (e.kind) {
    case 'num':
      return C.constForm(Math.abs(e.value));

    case 'var': {
      const v = env.get(e.name);
      if (v !== undefined) {
        if (v.k === 'const') return C.constForm(Math.abs(v.v));
        if (v.k === 'param') return { base: 0, terms: new Map([[v.name, 1]]) };
      }
      // Inside a loop the counter is no longer a constant; fall back to the
      // range the loop proof established, at its largest magnitude.
      for (let i = ctx.ranges.length - 1; i >= 0; i -= 1) {
        const range = ctx.ranges[i]?.get(e.name);
        if (range !== undefined) {
          return C.constForm(Math.max(Math.abs(range.lo), Math.abs(range.hi)));
        }
      }
      return null;
    }

    case 'bin': {
      if (e.op === '+') {
        const l = valueForm(e.left, env, ctx);
        const r = valueForm(e.right, env, ctx);
        return l === null || r === null ? null : C.add(l, r);
      }
      if (e.op === '-') {
        // `a - b` is bounded above by `|a| + |b|`; loose, never short.
        const l = valueForm(e.left, env, ctx);
        const r = valueForm(e.right, env, ctx);
        return l === null || r === null ? null : C.add(l, r);
      }
      if (e.op === '*') {
        const l = valueForm(e.left, env, ctx);
        const r = valueForm(e.right, env, ctx);
        if (l === null || r === null) return null;
        try {
          return C.mul(l, r);
        } catch {
          return null; // product of two symbolic arguments: refuse it
        }
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * A verified program must not be able to index outside an array: a raw arena
 * read would let one array observe another. Literals are checked by the
 * typechecker; here we require a proven range, which a bounded loop counter
 * inside `while i < len` provides.
 */
function proveIndex(index: Expr, len: number, env: Env, ctx: Ctx): void {
  const reject = (why: string): never => {
    throw new GsError('E_INDEX_OOB', `cannot prove index is in [0, ${len}): ${why}`, index.pos);
  };

  if (index.kind === 'num') {
    if (!Number.isInteger(index.value) || index.value < 0 || index.value >= len) {
      reject(`literal index ${index.value} is outside the array`);
    }
    return;
  }

  if (index.kind === 'var') {
    // A variable that still holds a literal is as good as the literal.
    const value = env.get(index.name);
    if (value !== undefined && value.k === 'const') {
      if (!Number.isInteger(value.v) || value.v < 0 || value.v >= len) {
        reject(`"${index.name}" holds ${value.v}, which is outside the array`);
      }
      return;
    }

    for (let i = ctx.ranges.length - 1; i >= 0; i -= 1) {
      const range = ctx.ranges[i]?.get(index.name);
      if (range === undefined) continue;
      if (range.lo >= 0 && range.hi < len) return;
      reject(`"${index.name}" ranges over [${range.lo}, ${range.hi}]`);
    }
    return reject(`"${index.name}" has no proven range in this loop`);
  }

  return reject('the index is not a literal or a bounded loop counter');
}

// ---- cost of expressions --------------------------------------------------

function opCost(op: string, t: import('./ast').Type): number {
  if (isIntegerType(t)) {
    if (op === '/' || op === '%') return 3;
    return 1;
  }
  if (op === '/') return 2;
  return 1;
}

function exprSum(e: Expr, env: Env, ctx: Ctx): Sum {
  switch (e.kind) {
    case 'num':
    case 'bool':
    case 'var':
      return constSum(1);

    case 'un': {
      const inner = exprSum(e.expr, env, ctx);
      return { cost: C.add(inner.cost, C.constForm(2)), mem: inner.mem };
    }

    case 'cast': {
      const inner = exprSum(e.expr, env, ctx);
      return { cost: C.add(inner.cost, C.constForm(1)), mem: inner.mem };
    }

    case 'index': {
      const target = exprSum(e.target, env, ctx);
      const idx = exprSum(e.index, env, ctx);
      const arr = e.target.type;
      if (arr !== undefined && arr.kind === 'array') {
        proveIndex(e.index, arr.len, env, ctx);
      } else {
        throw new GsError(
          'E_INDEX_OOB',
          'cannot prove an index into an expression whose type is unknown',
          e.pos,
        );
      }
      return {
        cost: C.add(C.add(target.cost, idx.cost), C.constForm(3)),
        mem: C.add(target.mem, idx.mem),
      };
    }

    case 'bin': {
      const left = exprSum(e.left, env, ctx);
      const right = exprSum(e.right, env, ctx);
      const mem = C.add(left.mem, right.mem);

      if (e.op === '&&') {
        return { cost: C.add(C.add(left.cost, right.cost), C.constForm(4)), mem };
      }
      if (e.op === '||') {
        return { cost: C.add(C.add(left.cost, right.cost), C.constForm(5)), mem };
      }

      const t = e.type;
      const isComparison = e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=' || e.op === '==' || e.op === '!=';
      const extra = isComparison ? 1 : opCost(e.op, t ?? { kind: 'f64' });
      return { cost: C.add(C.add(left.cost, right.cost), C.constForm(extra)), mem };
    }

    case 'call': {
      let args: Sum = sZero();
      for (const a of e.args) args = sAdd(args, exprSum(a, env, ctx));

      if (e.name === 'sqrt') return { cost: C.add(args.cost, C.constForm(8)), mem: args.mem };
      if (e.name === 'abs') return { cost: C.add(args.cost, C.constForm(2)), mem: args.mem };
      if (e.name === 'min' || e.name === 'max') {
        return { cost: C.add(args.cost, C.constForm(2)), mem: args.mem };
      }

      const sig = ctx.sigs.get(e.name);
      if (sig === undefined) {
        throw new GsError('E_GAS_UNBOUNDED', `call to "${e.name}" was not verified first`, e.pos);
      }

      // A callee's bound is a form over the *callee's* parameters. Charging it
      // unsubstituted would drop every term (the caller has no such parameter)
      // and undercount gas by the whole cost of the callee's loops.
      const argForms = e.args.map((a) => valueForm(a, env, ctx));
      const bind = (i: number, _name: string): C.Form | null => argForms[i] ?? null;

      let calleeCost: C.Form;
      let calleeMem: C.Form;
      try {
        calleeCost = C.substitute(sig.cost, sig.params, bind);
        calleeMem = C.substitute(sig.mem, sig.params, bind);
      } catch (err) {
        if (err instanceof C.NonlinearCost) {
          throw new GsError(
            'E_GAS_UNBOUNDED',
            `call to "${e.name}": ${err.message}`,
            e.pos,
          );
        }
        throw err;
      }

      return {
        cost: C.add(C.add(args.cost, calleeCost), C.constForm(5)), // CALL
        mem: C.add(args.mem, calleeMem),
      };
    }

    case 'arrayLit': {
      const n = e.elems.length;
      let cost = C.constForm(4 + n);
      let mem = C.constForm(n * ELEMENT_BYTES);
      for (const el of e.elems) {
        const s = exprSum(el, env, ctx);
        cost = C.add(cost, C.add(s.cost, C.constForm(5))); // load handle, push index, value, ARRAY_SET
        mem = C.add(mem, s.mem);
      }
      return { cost, mem };
    }

    case 'arrayRepeat': {
      const n = e.len;
      const v = exprSum(e.value, env, ctx);
      const cost = C.add(
        C.add(C.constForm(11 + 15 * n), C.mul(v.cost, C.constForm(n))),
        C.zero(),
      );
      const mem = C.add(C.constForm(n * ELEMENT_BYTES), C.mul(v.mem, C.constForm(n)));
      return { cost, mem };
    }
  }
}

// ---- cost of statements ---------------------------------------------------

function walkStmts(stmts: Stmt[], env: Env, ctx: Ctx): Sum {
  let total = sZero();
  for (const s of stmts) total = sAdd(total, walkStmt(s, env, ctx));
  return total;
}

function walkStmt(s: Stmt, env: Env, ctx: Ctx): Sum {
  switch (s.kind) {
    case 'let': {
      const init = exprSum(s.init, env, ctx);
      env.set(s.name, evalVal(s.init, env));
      return sAdd(init, constSum(1)); // STORELOC
    }

    case 'set': {
      const value = exprSum(s.value, env, ctx);
      env.set(s.name, evalVal(s.value, env));
      return sAdd(value, constSum(1));
    }

    case 'expr': {
      const inner = exprSum(s.expr, env, ctx);
      return sAdd(inner, constSum(1)); // POP
    }

    case 'return': {
      if (s.value === null) return constSum(4); // CONST 0, RET
      const value = exprSum(s.value, env, ctx);
      return sAdd(value, constSum(3)); // RET
    }

    case 'if': {
      const cond = exprSum(s.cond, env, ctx);

      const thenEnv = new Map(env);
      const thenSum = walkStmts(s.then, thenEnv, ctx);

      const elseEnv = new Map(env);
      const elseSum = s.els === null ? sZero() : walkStmts(s.els, elseEnv, ctx);

      // With an else arm the then-block ends in a JMP past it; without one it
      // falls straight through into the following block, so no jump is charged.
      const taken = s.els === null ? thenSum.cost : C.add(thenSum.cost, C.constForm(1));
      const cost = C.add(C.add(cond.cost, C.constForm(1)), C.maxForm(taken, elseSum.cost));
      const mem = C.add(cond.mem, C.maxForm(thenSum.mem, elseSum.mem));

      const merged = new Set([...assignedNames(s.then), ...(s.els === null ? [] : assignedNames(s.els))]);
      invalidate(env, merged);

      return { cost, mem };
    }

    case 'while': {
      const info = loopInfo(s.cond, s.body, env);
      const iters = info.iters;
      ctx.loops.push({ at: s.pos, iters });

      const condSum = exprSum(s.cond, env, ctx);

      const frame = new Map(ctx.ranges[ctx.ranges.length - 1] ?? []);
      const range = rangeFor(info.variant, env);
      if (range !== null) frame.set(info.variant.name, range);
      ctx.ranges.push(frame);

      // The body is charged once, so it must be priced for *any* iteration, not
      // for the values the first iteration happens to start with. Anything the
      // body assigns is therefore unknown here; loop counters are recovered
      // through `frame` above, never through a stale constant.
      const bodyEnv = new Map(env);
      invalidate(bodyEnv, assignedNames(s.body));
      const bodySum = walkStmts(s.body, bodyEnv, ctx);
      ctx.ranges.pop();

      const checks = C.add(condSum.cost, C.constForm(1)); // condition + JZ
      const perIter = C.add(bodySum.cost, C.constForm(1)); // body + JMP back
      const kPlus1 = C.add(iters, C.constForm(1));

      const cost = C.add(
        C.constForm(1), // JMP to the condition on entry
        C.add(C.mul(checks, kPlus1), C.mul(perIter, iters)),
      );
      const mem = C.add(condSum.mem, C.mul(bodySum.mem, iters));

      invalidate(env, assignedNames(s.body));
      return { cost, mem };
    }
  }
}

function allPathsReturn(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === 'return') return true;
    if (s.kind === 'if' && s.els !== null && allPathsReturn(s.then) && allPathsReturn(s.els)) return true;
  }
  return false;
}

// ---- orchestration --------------------------------------------------------

function postOrder(infos: FnInfo[]): FnInfo[] {
  const byName = new Map(infos.map((f) => [f.name, f]));
  const out: FnInfo[] = [];
  const seen = new Set<string>();

  const visit = (fn: FnInfo): void => {
    if (seen.has(fn.name)) return;
    seen.add(fn.name);
    for (const callee of callees(fn.decl)) {
      const next = byName.get(callee);
      if (next !== undefined) visit(next);
    }
    out.push(fn);
  };

  for (const fn of infos) visit(fn);
  return out;
}

function callees(fn: FnDecl): string[] {
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
      case 'cast':
        walkExpr(e.expr);
        return;
      case 'index':
        walkExpr(e.target);
        walkExpr(e.index);
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
      if (s.kind === 'let') walkExpr(s.init);
      else if (s.kind === 'set') walkExpr(s.value);
      else if (s.kind === 'expr') walkExpr(s.expr);
      else if (s.kind === 'return' && s.value !== null) walkExpr(s.value);
      else if (s.kind === 'if') {
        walkExpr(s.cond);
        walkStmts(s.then);
        if (s.els !== null) walkStmts(s.els);
      } else if (s.kind === 'while') {
        walkExpr(s.cond);
        walkStmts(s.body);
      }
    }
  };
  walkStmts(fn.body);
  return out;
}

/** Largest value a parameter of this type can take, used for the memory bound. */
function worstValue(t: Type): number {
  if (t.kind === 'i32') return 2147483647;
  if (t.kind === 'i64') return 9223372036854775807;
  if (t.kind === 'f64') return Number.MAX_SAFE_INTEGER;
  return 0; // bool/unit/array parameters cannot scale an allocation
}

/**
 * A certificate may only mention its own function's parameters.
 *
 * If a term from a callee ever leaked into a caller's form, `instantiate` would
 * read it as zero and publish a bound that is too small. Refusing to certify is
 * the safe failure: no certificate, no execution.
 */
function seal(f: C.Form, params: readonly string[], fn: string): void {
  for (const name of f.terms.keys()) {
    if (!params.includes(name)) {
      throw new GsError(
        'E_GAS_UNBOUNDED',
        `refusing to certify "${fn}": its bound mentions "${name}", which is not a parameter of "${fn}"`,
      );
    }
  }
}

export function verifyModule(mod: ReturnType<typeof parse>): VerifyResult {
  try {
    const infos = checkModule(mod);
    const ctx: Ctx = { sigs: new Map(), loops: [], ranges: [] };
    const certs: Certificate[] = [];

    for (const info of postOrder(infos)) {
      const env: Env = new Map();
      for (const p of info.decl.params) env.set(p.name, { k: 'param', name: p.name });

      const ctxForFn: Ctx = { sigs: ctx.sigs, loops: [], ranges: [] };
      const body = walkStmts(info.decl.body, env, ctxForFn);

      // The lowerer appends `CONST 0; RET` (4 gas) to every function, but that
      // block is unreachable when the typechecker proved that every path returns.
      const gas = allPathsReturn(info.decl.body) ? body.cost : C.add(body.cost, C.constForm(4));

      const paramNames = info.decl.params.map((p) => p.name);
      seal(gas, paramNames, info.name);
      seal(body.mem, paramNames, info.name);

      // The arena is fixed, so the memory bound must hold for every legal
      // argument, not just the ones the example happens to pass.
      const worst = new Map(info.decl.params.map((p) => [p.name, worstValue(p.type)]));
      const worstMem = C.instantiate(body.mem, worst);
      if (worstMem > ARENA_BYTES) {
        throw new GsError(
          'E_MEMORY',
          `"${info.name}" can allocate ${worstMem} bytes, more than the ${ARENA_BYTES}-byte arena`,
          info.decl.pos,
        );
      }

      ctx.sigs.set(info.name, { params: paramNames, cost: gas, mem: body.mem });

      certs.push({
        fn: info.name,
        gas,
        memoryBytes: body.mem,
        loops: ctxForFn.loops,
        obligations: ['O1', 'O2', 'O3', 'O4', 'O5', 'O6'],
      });
    }

    return { ok: true, certs };
  } catch (err) {
    if (err instanceof GsError) return { ok: false, code: err.code, detail: err.message };
    if (err instanceof C.NonlinearCost) {
      return { ok: false, code: 'E_GAS_UNBOUNDED', detail: err.message };
    }
    throw err;
  }
}

export function verifySource(source: string): VerifyResult {
  try {
    return verifyModule(parse(source));
  } catch (err) {
    if (err instanceof GsError) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
}

/** Convenience for the UI: look up one certificate, or explain why there is none. */
export function certificateFor(source: string, fn: string): Certificate | { code: DiagnosticCode; detail: string } {
  const result = verifySource(source);
  if (!result.ok) return { code: result.code, detail: result.detail };
  const cert = result.certs.find((c) => c.fn === fn);
  if (cert === undefined) return { code: 'E_SCOPE', detail: `no verified function named ${fn}` };
  return cert;
}


