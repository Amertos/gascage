import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile, runExample } from '../build/core.mjs';

const doc = JSON.parse(
  await readFile(new URL('../corpus/examples.json', import.meta.url), 'utf8'),
);

const valid = doc.examples.filter((e) => e.expect === 'valid');
const invalid = doc.examples.filter((e) => e.expect === 'invalid');

const close = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

for (const ex of valid) {
  test(`compiles and runs: ${ex.id}`, () => {
    const r = runExample(ex.code, ex.id, ex.args);
    assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.message}`);
    assert.ok(
      close(r.value, ex.expected),
      `${ex.id}: got ${r.value}, expected ${ex.expected}`,
    );
    assert.ok(r.gasUsed > 0, 'every run must charge gas');
  });
}

for (const ex of invalid) {
  test(`rejects with ${ex.code_expected}: ${ex.id}`, () => {
    const r = compile(ex.code);
    assert.equal(r.ok, false, `${ex.id} was accepted but should be rejected`);
    assert.equal(r.code, ex.code_expected, `${ex.id}: got ${r.code} (${r.message})`);
  });
}

test('compilation is deterministic: byte-identical block costs on a recompile', () => {
  const src = valid[0].code;
  const a = compile(src);
  const b = compile(src);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.program.fns[0].blockCosts, b.program.fns[0].blockCosts);
  assert.deepEqual(a.program.fns[0].code, b.program.fns[0].code);
});

test('the interpreter loop is unrolled into real blocks, not one giant block', () => {
  const ex = doc.examples.find((e) => e.id === 'slalom_katamaran');
  const r = compile(ex.code);
  assert.equal(r.ok, true);
  assert.ok(r.program.fns[0].blockStarts.length >= 4, 'loops and ifs must create blocks');
});

test('a syntax error is a diagnostic, not an exception', () => {
  const r = compile('fn main() -> i32 { return 1 }');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_PARSE');
});

test('an unknown entry point is reported instead of silently ignored', () => {
  const r = compile('fn a() -> i32 { return 1; }', { main: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_SCOPE');
});
