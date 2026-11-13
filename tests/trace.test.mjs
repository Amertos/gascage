import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder, TraceRecorder, run } from '../build/core.mjs';

/** countdown(n): i = n; steps = 0; while i > 0 { steps += 1; i -= 1 } return steps */
function countdown() {
  const b = new Builder();
  const f = b.fn('countdown', 1, 3);
  f.load(0).store(1); // i = n   (slot 0 is the parameter)
  f.const(0).store(2); // steps = 0
  f.jmp('cond');
  f.block('cond');
  f.load(1).const(0).igt().jz('done');
  f.block('body');
  f.load(2).const(1).fadd().store(2);
  f.load(1).const(1).fsub().store(1);
  f.jmp('cond');
  f.block('done');
  f.load(2).ret();
  return b.assemble();
}

function traced(prog, args, opts = {}) {
  const rec = new TraceRecorder();
  const r = run(prog, args, { gasLimit: 1_000_000, onBlock: rec.onBlock, ...opts });
  rec.trap = r.kind === 'trap' ? r.trap : undefined;
  rec.value = r.kind === 'ok' ? r.value : undefined;
  return { rec, r };
}

test('the same program and arguments produce the same trace hash', () => {
  const prog = countdown();
  const a = traced(prog, [5]);
  const b = traced(prog, [5]);
  assert.equal(a.rec.hash(), b.rec.hash());
  assert.deepEqual(a.rec.entries, b.rec.entries);
  assert.ok(a.rec.size() > 0, 'a trace must record something');
  assert.equal(a.r.value, 5);
});

test('different arguments produce a different trace, as they must', () => {
  const prog = countdown();
  const five = traced(prog, [5]);
  const three = traced(prog, [3]);
  assert.notEqual(five.rec.hash(), three.rec.hash());
  assert.notEqual(five.rec.size(), three.rec.size());
});

test('the block trace is identical with metering on and off', () => {
  const prog = countdown();
  const on = traced(prog, [4], { metering: true });
  const off = traced(prog, [4], { metering: false });
  assert.deepEqual(on.rec.entries, off.rec.entries, 'metering must not change control flow');
  assert.ok(on.r.gasUsed > 0);
  assert.equal(off.r.gasUsed, 0);
});

test('a trap is part of the trace identity', () => {
  const b = new Builder();
  const f = b.fn('boom', 0, 1);
  f.const(1).const(0).fdiv();
  f.ret();
  const prog = b.assemble();

  const ok = traced(countdown(), [2]);
  const boom = traced(prog, []);
  assert.notEqual(ok.rec.hash(), boom.rec.hash());
  assert.equal(boom.r.kind, 'trap');
  assert.equal(boom.rec.trap, 'DivByZero');
  assert.equal(boom.rec.hash(), traced(prog, []).rec.hash(), 'traps replay identically');
});

test('replay from a recorded trace reproduces the same outcome', () => {
  const prog = countdown();
  const first = traced(prog, [7]);

  const replay = new TraceRecorder();
  const again = run(prog, [7], { gasLimit: 1_000_000, onBlock: replay.onBlock });
  assert.equal(again.kind, 'ok');
  if (again.kind === 'ok') replay.value = again.value;

  assert.deepEqual(replay.entries, first.rec.entries, 'the block stream must replay exactly');
  assert.equal(replay.hash(), first.rec.hash(), 'and hash identically');
  assert.equal(again.kind === 'ok' ? again.value : null, first.r.value);
});
