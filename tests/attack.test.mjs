import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifySource, verifyAndRunExample } from '../build/core.mjs';

const doc = JSON.parse(readFileSync(new URL('../corpus/attacks.json', import.meta.url), 'utf8'));

for (const attack of doc.attacks) {
  if (attack.expect === 'rejected') {
    test(`refuses before running: ${attack.id} (${attack.code})`, () => {
      const r = verifySource(attack.source);
      assert.equal(r.ok, false, `${attack.id} was accepted — the verifier issued a bound it cannot defend`);
      assert.equal(r.code, attack.code, `${attack.id}: ${r.detail}`);
    });
    continue;
  }

  for (const args of attack.cases) {
    test(`contains: ${attack.id}${args.length > 0 ? `(${JSON.stringify(args)})` : ''}`, () => {
      const r = verifyAndRunExample(attack.source, attack.fn, args);
      assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.message}`);
      assert.ok(r.gasBound > 0, 'a bound of zero is not a bound');
      assert.ok(r.gasUsed <= r.gasBound, `${attack.id}: used ${r.gasUsed} of ${r.gasBound}`);
    });
  }
}

test('the corpus actually covers every attack vector and keeps its regressions', () => {
  const vectors = new Set(doc.attacks.map((a) => a.vector));
  for (const v of ['gas', 'termination', 'memory', 'index', 'recursion']) {
    assert.ok(vectors.has(v), `no attacks against "${v}"`);
  }

  const regressions = doc.attacks.filter((a) => a.regression === true);
  assert.ok(regressions.length >= 5, `only ${regressions.length} regression entries`);

  // A regression entry is only meaningful if it still names the hole it closed.
  for (const r of regressions) {
    assert.ok(r.why.length > 40, `${r.id} does not explain what was broken`);
  }
});

test('every attack id is unique', () => {
  const seen = new Set();
  for (const a of doc.attacks) {
    assert.ok(!seen.has(a.id), `duplicate attack id ${a.id}`);
    seen.add(a.id);
  }
});
