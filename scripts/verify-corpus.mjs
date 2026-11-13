/**
 * Verifies every corpus program and then runs it with the proven bound as the only
 * gas budget. Writes bench/verify.json; the published claim in claims.json points
 * at this command, so the number and the artifact cannot drift apart.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAndRunExample, verifySource, instantiate } from '../build/core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(await readFile(join(root, 'corpus', 'examples.json'), 'utf8'));

const valid = doc.examples.filter((e) => e.expect === 'valid');
const invalid = doc.examples.filter((e) => e.expect === 'invalid');

const rows = [];
let accepted = 0;
let withinBound = 0;
let totalSlack = 0;

for (const ex of valid) {
  const r = verifyAndRunExample(ex.code, ex.id, ex.args);
  const row = {
    id: ex.id,
    verified: r.ok,
    gasBound: r.ok ? r.gasBound : null,
    gasUsed: r.ok ? r.gasUsed : null,
    slack: r.ok ? r.slack : null,
    reason: r.ok ? null : `${r.code}: ${r.message}`,
  };
  rows.push(row);
  if (r.ok) {
    accepted += 1;
    if (r.gasUsed <= r.gasBound) withinBound += 1;
    totalSlack += r.slack;
  } else {
    console.error(`FAIL ${ex.id}: ${row.reason}`);
  }
}

let falseRejects = 0;
for (const ex of invalid) {
  const r = verifySource(ex.code);
  if (r.ok) {
    falseRejects += 1;
    console.error(`FAIL ${ex.id}: accepted a program that must be rejected`);
  }
}

const percentWithin = accepted === 0 ? 0 : (withinBound / accepted) * 100;
const avgSlack = accepted === 0 ? 0 : totalSlack / accepted;

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  programs: valid.length,
  accepted,
  withinBound,
  percentWithinBound: Number(percentWithin.toFixed(1)),
  falseRejects,
  averageSlack: Number(avgSlack.toFixed(1)),
  rows,
};

console.log('gascage verifier (S5)');
console.log('  program                       bound   used   slack');
for (const row of rows) {
  if (!row.verified) {
    console.log(`  ${row.id.padEnd(28)} REJECTED  ${row.reason}`);
    continue;
  }
  console.log(
    `  ${row.id.padEnd(28)} ${String(row.gasBound).padStart(6)} ${String(row.gasUsed).padStart(6)} ${String(row.slack).padStart(7)}`,
  );
}
console.log('');
console.log(`  accepted programs            ${accepted}/${valid.length}`);
console.log(`  ran within the proven bound  ${withinBound}/${accepted} (${report.percentWithinBound}%)`);
console.log(`  required programs rejected   ${falseRejects} (must be 0)`);
console.log(`  average slack                ${report.averageSlack} gas`);

await mkdir(join(root, 'bench'), { recursive: true });
await writeFile(join(root, 'bench', 'verify.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('wrote bench/verify.json');

// A verifier that rejects everything would otherwise "pass" every soundness check.
const complete = accepted === valid.length;
if (!complete) {
  console.error(`VERIFIER FAILED: only ${accepted}/${valid.length} valid programs were accepted`);
}
if (withinBound !== accepted || falseRejects !== 0) {
  console.error('VERIFIER FAILED: the bound is not sound or the verifier is not rejecting');
}
if (!complete || withinBound !== accepted || falseRejects !== 0) process.exit(1);
