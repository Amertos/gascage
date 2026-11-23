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
 * Rebinds a cost form's parameters to argument forms.
 *
 * A callee's certificate is a form over the *callee's* parameters. Charging it at
 * a call site without substitution silently drops those terms (the caller has no
 * such parameter, so `instantiate` would read zero) and undercounts the gas by
 * whatever the loop would have cost. That is exactly the bug this function
 * exists to make impossible.
 *
 * `argFor` is required only for parameters the form actually mentions, so array
 * arguments — which never appear in a cost form — need no numeric form.
 */
export function substitute(
  f: Form,
  params: readonly string[],
  argFor: (index: number, name: string) => Form | null,
): Form {
  let out = constForm(f.base);
  for (const [name, coef] of f.terms) {
    const i = params.indexOf(name);
    if (i < 0) throw new NonlinearCost(`cost form mentions "${name}", which is not a parameter`);
    const arg = argFor(i, name);
    if (arg === null) {
      throw new NonlinearCost(`argument ${i + 1} of the call is not a constant or a parameter`);
    }
    out = add(out, scale(arg, coef));
  }
  return out;
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
  for (const [name, coef] of f.terms) {
    // `|coef|` is belt-and-braces: substitution normalises arguments to
    // magnitudes, and this keeps a negative coefficient from ever turning into a
    // discount if a future analysis produces one.
    total += Math.abs(coef) * Math.abs(args.get(name) ?? 0);
  }
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
