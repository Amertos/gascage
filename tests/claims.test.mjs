import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const doc = JSON.parse(await readFile(new URL('../bench/claims.json', import.meta.url), 'utf8'));

test('claims table is well formed', () => {
  assert.ok(Array.isArray(doc.claims) && doc.claims.length > 0);
  const ids = doc.claims.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'claim ids must be unique');
});

test('no unproven number is published', () => {
  for (const c of doc.claims) {
    if (c.status === 'measured') {
      assert.equal(typeof c.value, 'number', `${c.id}: measured needs a number`);
      assert.ok(c.reproduce, `${c.id}: measured needs a reproduce command`);
    } else {
      assert.equal(c.value, null, `${c.id}: only measured claims may carry a value`);
    }
  }
});

test('every claim names the milestone that will produce it', () => {
  for (const c of doc.claims) {
    assert.match(c.milestone, /^S\d+$/, `${c.id}: milestone must look like S5`);
    assert.ok(c.text.length > 20, `${c.id}: claim text must say what is measured`);
  }
});
