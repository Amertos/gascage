/**
 * Red-team corpus runner (S6).
 *
 * For every attack that must be refused, the verifier has to refuse it *before
 * execution* with the expected diagnostic. For every attack that is legitimately
 * accepted, the program is run with the proven bound as its entire gas budget,
 * under adversarial arguments: reaching OutOfGas there means the proof was short.
 *
 * Writes bench/attacks.json. Exits non-zero on any escape, so CI can gate on it.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySource, verifyAndRunExample } from '../build/core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(await readFile(join(root, 'corpus', 'attacks.json'), 'utf8'));

const rows = [];
const failures = [];
let rejected = 0;
let runs = 0;
let worstSlackRatio = 0;

for (const attack of doc.attacks) {
  if (attack.expect === 'rejected') {
    const result = verifySource(attack.source);
    const held = !result.ok && result.code === attack.code;
    if (!held) {
      failures.push(
        result.ok
          ? `${attack.id}: verifier accepted an attack`
          : `${attack.id}: expected ${attack.code}, got ${result.code} (${result.detail})`,
      );
    } else {
      rejected += 1;
    }
    rows.push({
      id: attack.id,
      vector: attack.vector,
      expect: attack.expect,
      got: result.ok ? 'accepted' : result.code,
      held,
      regression: attack.regression === true,
    });
    continue;
  }

  for (const args of attack.cases) {
    const run = verifyAndRunExample(attack.source, attack.fn, args);
    let held = false;
    if (!run.ok) {
      failures.push(`${attack.id}(${JSON.stringify(args)}): ${run.code}: ${run.message}`);
    } else if (run.gasUsed > run.gasBound) {
      failures.push(
        `${attack.id}(${JSON.stringify(args)}): used ${run.gasUsed} of ${run.gasBound} proven gas`,
      );
    } else {
      held = true;
      runs += 1;
      worstSlackRatio = Math.max(worstSlackRatio, run.gasBound === 0 ? 0 : run.slack / run.gasBound);
    }
    rows.push({
      id: `${attack.id}(${JSON.stringify(args)})`,
      vector: attack.vector,
      expect: attack.expect,
      got: run.ok ? `ran ${run.gasUsed}/${run.gasBound}` : run.code,
      held,
      regression: attack.regression === true,
    });
  }
}

const regressions = doc.attacks.filter((a) => a.regression === true).length;

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  attacks: doc.attacks.length,
  refused: rejected,
  containedRuns: runs,
  escapes: failures.length,
  regressions,
  worstSlackRatio: Number(worstSlackRatio.toFixed(3)),
  rows,
};

console.log('gascage red-team corpus (S6)');
console.log(`  attacks                 ${doc.attacks.length}`);
console.log(`  refused before running  ${rejected}`);
console.log(`  accepted and contained  ${runs} run(s)`);
console.log(`  regressions             ${regressions}`);
console.log(`  escapes                 ${failures.length} (must be 0)`);
console.log(`  worst slack / bound     ${(worstSlackRatio * 100).toFixed(1)}%`);

if (failures.length > 0) {
  console.error('');
  for (const f of failures) console.error(`  FAIL ${f}`);
}

await mkdir(join(root, 'bench'), { recursive: true });
await writeFile(join(root, 'bench', 'attacks.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('wrote bench/attacks.json');

if (failures.length > 0) process.exit(1);
