#!/usr/bin/env node
/**
 * Bench harness (S0). Today it only validates and summarises bench/claims.json,
 * because no VM exists yet. From S2 it will run real measurements and write the
 * numbers back, so the UI and the README can never drift from reality.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const claimsPath = join(root, 'bench', 'claims.json');
const outPath = join(root, 'bench', 'out.json');

const doc = JSON.parse(await readFile(claimsPath, 'utf8'));
const errors = [];

if (!Array.isArray(doc.claims) || doc.claims.length === 0) {
  errors.push('claims.json must contain a non-empty "claims" array');
}

const seen = new Set();
for (const [i, c] of (doc.claims ?? []).entries()) {
  const at = `claims[${i}] (${c?.id ?? '?'})`;
  if (!c?.id) errors.push(`${at}: missing id`);
  else if (seen.has(c.id)) errors.push(`${at}: duplicate id`);
  else seen.add(c.id);

  if (!['not_measured', 'measured', 'withdrawn'].includes(c?.status)) {
    errors.push(`${at}: invalid status "${c?.status}"`);
  }
  if (c?.status === 'measured' && (typeof c.value !== 'number' || !c.reproduce)) {
    errors.push(`${at}: measured requires a numeric value and a reproduce command`);
  }
  if (c?.status !== 'measured' && c?.value !== null) {
    errors.push(`${at}: only measured claims may carry a value (got ${c?.value})`);
  }
}

const byStatus = { measured: 0, not_measured: 0, withdrawn: 0 };
for (const c of doc.claims ?? []) {
  if (c.status in byStatus) byStatus[c.status] += 1;
}

const out = {
  generatedAt: new Date().toISOString(),
  claimsVersion: doc.version,
  total: doc.claims?.length ?? 0,
  byStatus,
  errors,
  note: 'No measurements exist yet. S2 adds VM timings, S4 fuzzing, S5 verification.',
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);

console.log(
  `claims: ${out.total} total — ${byStatus.measured} measured, ${byStatus.not_measured} not measured, ${byStatus.withdrawn} withdrawn`,
);
if (errors.length > 0) {
  console.error(`\n${errors.length} claim integrity error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('claim table is internally consistent (no unproven numbers published)');
