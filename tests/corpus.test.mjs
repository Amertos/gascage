import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const doc = JSON.parse(
  await readFile(new URL('../corpus/examples.json', import.meta.url), 'utf8'),
);

const valid = doc.examples.filter((e) => e.expect === 'valid');
const invalid = doc.examples.filter((e) => e.expect === 'invalid');

test('corpus has the 10 valid / 10 invalid split fixed by the spec', () => {
  assert.equal(doc.examples.length, 20);
  assert.equal(valid.length, 10);
  assert.equal(invalid.length, 10);
});

test('every corpus entry declares what it proves', () => {
  const ids = doc.examples.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const e of doc.examples) {
    assert.ok(e.code.includes('fn '), `${e.id}: must contain a function`);
    assert.ok(e.why.length > 10, `${e.id}: must explain why it is valid or invalid`);
  }
});

test('every valid entry is executable: args and an expected result', () => {
  for (const e of doc.examples.filter((x) => x.expect === 'valid')) {
    assert.ok(Array.isArray(e.args), `${e.id}: valid entries need args`);
    assert.equal(typeof e.expected, 'number', `${e.id}: valid entries need a numeric expectation`);
  }
});

test('invalid entries cover ten distinct diagnostic codes', () => {
  const codes = invalid.map((e) => e.code_expected);
  for (const c of codes) assert.match(c, /^E_[A-Z_]+$/, `bad diagnostic code ${c}`);
  assert.equal(new Set(codes).size, 10, 'each invalid example must demonstrate a distinct failure');
});

test('valid entries exercise the features the spec promises', () => {
  const ids = new Set(valid.map((e) => e.id));
  for (const required of ['dot_product', 'slalom_katamaran', 'cast_degrees', 'sqrt_margin']) {
    assert.ok(ids.has(required), `missing valid example: ${required}`);
  }
});
