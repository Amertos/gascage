import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifySource, verifyAndRunExample, instantiate, compile, run } from '../build/core.mjs';

const doc = JSON.parse(
  await readFile(new URL('../corpus/examples.json', import.meta.url), 'utf8'),
);

const valid = doc.examples.filter((e) => e.expect === 'valid');

for (const ex of valid) {
  test(`proves a bound and runs inside it: ${ex.id}`, () => {
    const r = verifyAndRunExample(ex.code, ex.id, ex.args);
    assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.message}`);
    assert.ok(r.gasBound > 0, 'a bound of zero is not a bound');
    assert.ok(
      r.gasUsed <= r.gasBound,
      `${ex.id}: used ${r.gasUsed} gas but only ${r.gasBound} was proven`,
    );
    assert.ok(r.slack >= 0);
  });
}

test('the proof is not trivially loose: every corpus program uses at least 50% of its bound', () => {
  for (const ex of valid) {
    const r = verifyAndRunExample(ex.code, ex.id, ex.args);
    assert.equal(r.ok, true);
    assert.ok(
      r.gasUsed >= r.gasBound * 0.5,
      `${ex.id}: used only ${r.gasUsed} of ${r.gasBound} — the bound is too loose to mean anything`,
    );
  }
});

test('rejected programs never reach the verifier as accepted', () => {
  for (const ex of doc.examples.filter((e) => e.expect === 'invalid')) {
    const r = verifySource(ex.code);
    assert.equal(r.ok, false, `${ex.id} should be rejected`);
    assert.equal(r.code, ex.code_expected, `${ex.id}: got ${r.code}`);
  }
});

test('a loop bounded by a parameter gets a symbolic bound that holds when instantiated', () => {
  const src = `
    fn count(n: i32) -> i32 {
      let i: i32 = 0;
      while i < n {
        i = i + 1;
      }
      return i;
    }
  `;
  const r = verifySource(src);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.detail}`);
  const cert = r.certs.find((c) => c.fn === 'count');
  assert.ok(cert);

  const coef = cert.gas.terms.get('n') ?? 0;
  assert.ok(coef >= 9, `per-iteration coefficient ${coef} looks too small`);

  for (const n of [-5, 0, 1, 5, 50]) {
    const bound = instantiate(cert.gas, new Map([['n', n]]));
    const compiled = compile(src);
    assert.equal(compiled.ok, true);
    const result = run(compiled.program, [n], { gasLimit: bound });
    assert.equal(result.kind, 'ok', `n=${n} trapped under its own bound (${bound})`);
    assert.ok(result.gasUsed <= bound, `n=${n}: used ${result.gasUsed} > ${bound}`);
  }
});

test('a loop whose counter cannot be bounded is refused with E_GAS_UNBOUNDED', () => {
  const src = `
    fn weird(x: i32) -> i32 {
      let i: i32 = x;
      while i < 10 {
        i = i + 1;
        i = x;
      }
      return i;
    }
  `;
  const r = verifySource(src);
  assert.equal(r.ok, false);
  assert.ok(['E_GAS_UNBOUNDED', 'E_UNBOUNDED_LOOP'].includes(r.code), `got ${r.code}`);
});

test('memory bound accounts for every array the program can allocate', () => {
  const src = `
    fn make() -> f64 {
      let a: [f64; 8] = [0.0; 8];
      return a[0];
    }
  `;
  const r = verifySource(src);
  assert.equal(r.ok, true);
  const cert = r.certs.find((c) => c.fn === 'make');
  assert.ok(cert);
  assert.ok(cert.memoryBytes.base >= 64, `memory bound ${cert.memoryBytes.base} < 64 bytes`);
  assert.ok(cert.memoryBytes.base <= 4096, 'memory bound must stay inside the arena');
});
