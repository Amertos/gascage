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
import { verifySource, verifyAndRunExample, instantiate, compile, run } from '../build/core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(await readFile(join(root, 'corpus', 'attacks.json'), 'utf8'));

const rows = [];
const failures = [];
let rejected = 0;
let runs = 0;
let trapped = 0;
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

  if (attack.expect === 'traps') {
    // The certificate bounds gas, not arithmetic. A program that traps must still
    // trap inside the bound it was given, never after spending more than proven.
    const verified = verifySource(attack.source);
    const compiled = compile(attack.source, { main: attack.fn });
    let held = false;
    if (!verified.ok) {
      failures.push(`${attack.id}: rejected with ${verified.code}, expected a bound and a trap`);
    } else if (!compiled.ok) {
      failures.push(`${attack.id}: does not compile: ${compiled.message}`);
    } else {
      const cert = verified.certs.find((c) => c.fn === attack.fn);
      const params = compiled.fns.find((f) => f.name === attack.fn)?.params ?? [];
      const bound = instantiate(cert.gas, new Map(params.map((p, i) => [p.name, attack.args[i]])));
      const result = run(compiled.program, attack.args, { gasLimit: bound });
      // Spec §9 charges one gas for the trap itself before raising it, so a
      // trapping execution is allowed exactly one gas above the bound: the bound
      // covers completed executions (spec §11.3), and the surcharge is the
      // price of metering the trap at all.
      if (result.kind !== 'trap' || result.trap !== attack.trap) {
        failures.push(`${attack.id}: expected trap ${attack.trap}, got ${JSON.stringify(result)}`);
      } else if (result.gasUsed > bound + 1) {
        failures.push(
          `${attack.id}: trapped after ${result.gasUsed} gas, over the ${bound} proven bound anyway`,
        );
      } else {
        held = true;
        trapped += 1;
      }
      rows.push({
        id: attack.id,
        vector: attack.vector,
        expect: attack.expect,
        got: result.kind === 'trap' ? result.trap : result.kind,
        held,
        regression: attack.regression === true,
      });
    }
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
  trappedInsideBound: trapped,
  escapes: failures.length,
  regressions,
  worstSlackRatio: Number(worstSlackRatio.toFixed(3)),
  rows,
};

console.log('gascage red-team corpus (S6)');
console.log(`  attacks                 ${doc.attacks.length}`);
console.log(`  refused before running  ${rejected}`);
console.log(`  accepted and contained  ${runs} run(s)`);
console.log(`  trapped inside bound    ${trapped} run(s)`);
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
