/**
 * Cost forms. A cost is a linear polynomial over the function's parameters:
 *
 *   base + Σ coeff_k · param_k
 *
 * Instruction costs are constants, so the only source of terms is a loop whose
 * trip count depends on an argument. Products of two symbolic forms are refused
 * (that is what `NonlinearCost` is for) rather than silently linearised — a
 * bound that is not sound is worse than no bound.
 */
export interface Form {
  base: number;
  terms: Map<string, number>;
}

export class NonlinearCost extends Error {}

export function zero(): Form {
  return { base: 0, terms: new Map() };
}

export function constForm(n: number): Form {
  return { base: n, terms: new Map() };
}

export function add(a: Form, b: Form): Form {
  const terms = new Map(a.terms);
  for (const [name, coef] of b.terms) terms.set(name, (terms.get(name) ?? 0) + coef);
  return { base: a.base + b.base, terms };
}

export function scale(a: Form, k: number): Form {
  const terms = new Map<string, number>();
  for (const [name, coef] of a.terms) terms.set(name, coef * k);
  return { base: a.base * k, terms };
}

export function mul(a: Form, b: Form): Form {
  if (a.terms.size > 0 && b.terms.size > 0) {
    throw new NonlinearCost('product of two parameter-dependent bounds');
  }
  return a.terms.size === 0 ? scale(b, a.base) : scale(a, b.base);
}

/** Componentwise maximum is a sound upper bound because every coefficient is ≥ 0. */
export function maxForm(a: Form, b: Form): Form {
  const terms = new Map(a.terms);
  for (const [name, coef] of b.terms) terms.set(name, Math.max(terms.get(name) ?? 0, coef));
  return { base: Math.max(a.base, b.base), terms };
}

/**
 * Evaluates a cost form at concrete arguments.
 *
 * Magnitudes, not signed values: a symbolic loop count is `p/step`, which is an
 * upper bound for `p ≥ 0` but negative for `p < 0`, where the true trip count is
 * zero. Using `|p|` keeps the result an upper bound for every sign while staying
 * linear. The bound is therefore sound but can be loose for negative arguments —
 * stated here rather than hidden.
 */
export function instantiate(f: Form, args: ReadonlyMap<string, number>): number {
  let total = f.base;
  for (const [name, coef] of f.terms) total += coef * Math.abs(args.get(name) ?? 0);
  return Math.max(0, Math.ceil(total));
}

export function isConstant(f: Form): boolean {
  return f.terms.size === 0;
}

export function formatForm(f: Form): string {
  const parts = [`${Math.round(f.base * 100) / 100}`];
  for (const [name, coef] of f.terms) {
    const c = Math.round(coef * 1000) / 1000;
    parts.push(`${c >= 0 ? '+' : '-'} ${Math.abs(c)}·${name}`);
  }
  return parts.join(' ');
}
