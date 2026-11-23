/**
 * Loop variants (spec v0.1 §7, obligation O3).
 *
 * One analysis, used by both the typechecker (termination) and the verifier
 * (trip count), so the two can never disagree about what counts as a step.
 *
 * The rule is deliberately narrow: a loop is bounded only when its body advances
 * the induction variable by **exactly one constant step on every path**, and
 * touches the variable nowhere else. That rejects the two shapes that walk
 * straight past a naive "somewhere in the body there is a step" check:
 *
 *   while i < n { if c { i = i + 1; } }   // no progress when c is false
 *   while i < n { i = i + 1; i = i - 1; } // steps twice, net zero
 *
 * Rejection is the default: `loopVariant` returns a reason instead of guessing.
 */
import type { Expr, Stmt } from './ast';

export interface Variant {
  /** The induction variable. */
  name: string;
  /** Signed change per iteration: positive for a counter that rises. */
  delta: number;
  /** The loop limit, in the canonical orientation `name <op> limit`. */
  limit: Expr;
  /** True for `<=` / `>=`. */
  inclusive: boolean;
  /** True for `<` / `<=`. */
  ascending: boolean;
}

export type VariantResult = { ok: true; variant: Variant } | { ok: false; why: string };

function isOrdering(op: string): boolean {
  return op === '<' || op === '<=' || op === '>' || op === '>=';
}

/** `a < i` means `i > a`; keep one orientation for the rest of the analysis. */
function flip(op: '<' | '<=' | '>' | '>='): '<' | '<=' | '>' | '>=' {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
  }
}

/**
 * The signed step of `value` applied to `name`, or null when this assignment is
 * not a constant step of that variable.
 *
 * `i + 1` -> +1, `1 + i` -> +1, `i - 2` -> -2. Anything else (including
 * `i + (1 + 1)`, which the parser nests) is refused rather than interpreted.
 */
function literalStep(value: Expr, name: string): number | null {
  if (value.kind !== 'bin') return null;

  const leftCounter = value.left.kind === 'var' && value.left.name === name;
  const rightCounter = value.right.kind === 'var' && value.right.name === name;

  if (value.op === '+') {
    if (leftCounter && value.right.kind === 'num') return integer(value.right.value);
    if (rightCounter && value.left.kind === 'num') return integer(value.left.value);
    return null;
  }
  if (value.op === '-') {
    if (!leftCounter || value.right.kind !== 'num') return null;
    const amount = integer(value.right.value);
    return amount === null ? null : -amount;
  }
  return null;
}

function integer(v: number): number | null {
  return Number.isInteger(v) ? v : null;
}

interface Scan {
  /** Every guaranteed step found, in source order. */
  steps: number[];
  /** Number of places that assign or shadow the counter, including bad ones. */
  touches: number;
}

/**
 * Collect the step that the body guarantees on *every* path.
 *
 * An `if` only counts when both arms are the same single step and nothing else
 * touches the counter. A `while` that mentions the counter refuses the loop: the
 * counter's value after the inner loop is not a function of one outer iteration.
 */
function scanSteps(stmts: Stmt[], name: string, out: Scan): void {
  for (const s of stmts) {
    if (s.kind === 'let') {
      if (s.name === name) out.touches += 1; // shadowing the counter: refuse
      continue;
    }

    if (s.kind === 'set') {
      if (s.name !== name) continue;
      out.touches += 1;
      const step = literalStep(s.value, name);
      if (step !== null) out.steps.push(step);
      continue;
    }

    if (s.kind === 'if') {
      const thenScan: Scan = { steps: [], touches: 0 };
      scanSteps(s.then, name, thenScan);

      const elseScan: Scan = { steps: [], touches: 0 };
      if (s.els !== null) scanSteps(s.els, name, elseScan);

      const thenStep = thenScan.touches === 1 ? thenScan.steps[0] : undefined;
      const elseStep =
        s.els !== null && elseScan.touches === 1 ? elseScan.steps[0] : undefined;

      if (thenStep !== undefined && elseStep !== undefined && thenStep === elseStep) {
        // Both paths advance by the same amount: the step is guaranteed.
        out.steps.push(thenStep);
        out.touches += 1;
      } else if (thenScan.touches + elseScan.touches > 0) {
        // Conditional progress is not progress.
        out.touches += 1;
      }
      continue;
    }

    if (s.kind === 'while') {
      const inner: Scan = { steps: [], touches: 0 };
      scanSteps(s.body, name, inner);
      if (inner.touches > 0) out.touches += 1;
      continue;
    }
  }
}

/** The single guaranteed constant step applied to `name`, or null. */
export function counterStep(body: Stmt[], name: string): number | null {
  const scan: Scan = { steps: [], touches: 0 };
  scanSteps(body, name, scan);
  if (scan.touches !== 1 || scan.steps.length !== 1) return null;
  return scan.steps[0] ?? null;
}

export function loopVariant(cond: Expr, body: Stmt[]): VariantResult {
  if (cond.kind !== 'bin') return { ok: false, why: 'the condition is not a comparison' };
  if (!isOrdering(cond.op)) {
    return { ok: false, why: `operator "${cond.op}" does not order a counter against a limit` };
  }

  let name: string;
  let limit: Expr;
  let op = cond.op as '<' | '<=' | '>' | '>=';

  if (cond.left.kind === 'var') {
    name = cond.left.name;
    limit = cond.right;
  } else if (cond.right.kind === 'var') {
    name = cond.right.name;
    limit = cond.left;
    op = flip(op);
  } else {
    return { ok: false, why: 'the condition must compare a variable with a limit' };
  }

  const delta = counterStep(body, name);
  if (delta === null) {
    return {
      ok: false,
      why: `"${name}" is not advanced by exactly one constant step on every path`,
    };
  }

  const ascending = op === '<' || op === '<=';
  if (ascending && delta <= 0) {
    return { ok: false, why: `"${name}" does not increase towards the exit` };
  }
  if (!ascending && delta >= 0) {
    return { ok: false, why: `"${name}" does not decrease towards the exit` };
  }

  return {
    ok: true,
    variant: {
      name,
      delta,
      limit,
      inclusive: op === '<=' || op === '>=',
      ascending,
    },
  };
}

/** Initial value of the counter when it is a literal, otherwise null. */
export function literalNumber(e: Expr): number | null {
  return e.kind === 'num' ? e.value : null;
}
