/**
 * VM benchmarks (S2). Two measurements, because one number would be a lie:
 *
 *  1. Wall clock with metering on vs off, interleaved. Reported three ways:
 *     min-of-runs (least contaminated), paired median, and the spread between
 *     them. If the effect sits inside the spread, the report says so.
 *  2. The cost of one gas check in nanoseconds, microbenchmarked directly.
 *     Overhead scales with block density, so this number is the one that
 *     transfers to other programs: overhead ≈ checks x checkNs / nsPerIteration.
 */
import { Builder, run } from '../build/core.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERS = 1_000_000;
const RUNS = 11;
const GAS_LIMIT = 1_000_000_000;
const CHECKS_PER_ITER = 3; // cond, body and jmp blocks
const INSTR_PER_ITER = 9;

/** acc = 0; i = 0; while (i < ITERS) { acc += 1.5; i += 1; } return acc */
function hotLoop(iterations) {
  const b = new Builder();
  const f = b.fn('hot', 0, 2);
  f.const(0).store(0);
  f.const(0).store(1);
  f.jmp('cond');
  f.block('cond');
  f.load(1).const(iterations).ilt().jz('done');
  f.load(0).const(1.5).fadd().store(0);
  f.load(1).const(1).fadd().store(1);
  f.jmp('cond');
  f.block('done');
  f.load(0).ret();
  return b.assemble();
}

const prog = hotLoop(ITERS);
const now = () => Number(process.hrtime.bigint()) / 1e6;

function timeRun(metering) {
  const t0 = now();
  const r = run(prog, [], { gasLimit: GAS_LIMIT, metering });
  const ms = now() - t0;
  if (r.kind !== 'ok') throw new Error(`unexpected trap: ${r.kind === 'trap' ? r.trap : ''}`);
  if (r.value !== 1.5 * ITERS) throw new Error(`wrong result ${r.value}`);
  return ms;
}

for (let i = 0; i < 4; i++) {
  timeRun(true);
  timeRun(false);
}

const onMsList = [];
const offMsList = [];
const ratios = [];
for (let i = 0; i < RUNS; i++) {
  const on = timeRun(true);
  const off = timeRun(false);
  onMsList.push(on);
  offMsList.push(off);
  ratios.push(on / off);
}

const min = (xs) => Math.min(...xs);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

const minOn = min(onMsList);
const minOff = min(offMsList);
const overheadMinPct = (minOn / minOff - 1) * 100;
const overheadMedianPct = (median(ratios) - 1) * 100;
const spreadPct = (Math.max(...ratios) - Math.min(...ratios)) * 100;

/** Cost of one gas check, on the same operation the dispatch loop runs. */
function checkCostNs(samples = 30_000_000) {
  let gas = 1e15;
  const cost = 4;
  let sink = 0;
  const t0 = now();
  for (let i = 0; i < samples; i++) {
    if (gas < cost) gas = 1e15;
    gas -= cost;
    sink += gas & 1;
  }
  const ns = ((now() - t0) * 1e6) / samples;
  if (sink < 0) throw new Error('unreachable');
  return ns;
}

const checkNs = min(Array.from({ length: 5 }, () => checkCostNs()));
const nsPerIteration = (minOn * 1e6) / ITERS;
const analyticalPct = ((CHECKS_PER_ITER * checkNs) / nsPerIteration) * 100;

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  program: `hot loop: ${INSTR_PER_ITER} instructions, ${CHECKS_PER_ITER} blocks`,
  iterations: ITERS,
  runsPerMode: RUNS,
  meteringOnMinMs: Number(minOn.toFixed(2)),
  meteringOffMinMs: Number(minOff.toFixed(2)),
  overheadMinPct: Number(overheadMinPct.toFixed(2)),
  overheadMedianPct: Number(overheadMedianPct.toFixed(2)),
  runToRunSpreadPct: Number(spreadPct.toFixed(2)),
  checkCostNs: Number(checkNs.toFixed(3)),
  analyticalOverheadPct: Number(analyticalPct.toFixed(2)),
  nsPerIteration: Number(nsPerIteration.toFixed(1)),
  iterationsPerSec: Math.round((ITERS / minOn) * 1000),
  instructionsPerSec: Math.round(((ITERS * INSTR_PER_ITER) / minOn) * 1000),
  noiseDominated: Math.abs(overheadMinPct) < 1,
};

console.log('gascage VM bench (S2)');
console.log(`  iterations          ${ITERS.toLocaleString('en-US')} x ${INSTR_PER_ITER} instructions, ${CHECKS_PER_ITER} blocks each`);
console.log(`  metering on         ${report.meteringOnMinMs} ms  (${report.iterationsPerSec.toLocaleString('en-US')} iter/s, ${report.instructionsPerSec.toLocaleString('en-US')} instr/s)`);
console.log(`  metering off        ${report.meteringOffMinMs} ms`);
console.log(`  wall clock min-of-11 ${report.overheadMinPct}%  (noisy, not published)`);
console.log(`  wall clock median   ${report.overheadMedianPct}%  (run-to-run spread ${report.runToRunSpreadPct}%)`);
console.log(`  gas check cost      ${report.checkCostNs} ns`);
console.log(`  overhead analytical ${report.analyticalOverheadPct}%  = ${CHECKS_PER_ITER} x ${report.checkCostNs} ns / ${report.nsPerIteration} ns per iteration`);
if (report.noiseDominated) {
  console.log('  note: wall-clock effect is inside the noise floor; the analytical figure is the defensible one');
}

await mkdir(join(root, 'bench'), { recursive: true });
await writeFile(join(root, 'bench', 'vm.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('wrote bench/vm.json');
