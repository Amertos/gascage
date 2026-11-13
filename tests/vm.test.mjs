import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Builder, Trap, run } from '../build/core.mjs';

const GAS = 1_000_000;

/** n! iteratively; demonstrates gas, locals and a bounded loop. */
function factorial() {
  const b = new Builder();
  const f = b.fn('factorial', 1, 2);
  f.const(1).store(1);
  f.jmp('cond');
  f.block('cond');
  f.load(0).const(1).igt().jz('done');
  f.load(1).load(0).fmul().store(1);
  f.load(0).const(1).fsub().store(0);
  f.jmp('cond');
  f.block('done');
  f.load(1).ret();
  return b.assemble();
}

/** iterative fib: a=0, b=1, i=0, t; while i<n { t=a+b; a=b; b=t; i++ } return a */
function fib() {
  const b = new Builder();
  const f = b.fn('fib', 1, 5);
  f.const(0).store(1);
  f.const(1).store(2);
  f.const(0).store(3);
  f.jmp('cond');
  f.block('cond');
  f.load(3).load(0).ilt().jz('done');
  f.load(1).load(2).fadd().store(4);
  f.load(2).store(1);
  f.load(4).store(2);
  f.load(3).const(1).fadd().store(3);
  f.jmp('cond');
  f.block('done');
  f.load(1).ret();
  return b.assemble();
}

/** sum of 0..n-1 stored in an arena array, then summed. */
function sumArray(n) {
  const b = new Builder();
  const f = b.fn('sum', 0, 4);
  f.arrayNew(n).store(1);
  f.const(0).store(2);
  f.jmp('fill_cond');
  f.block('fill_cond');
  f.load(2).const(n).ilt().jz('sum_init');
  f.load(1).load(2).load(2).arraySet();
  f.load(2).const(1).fadd().store(2);
  f.jmp('fill_cond');
  f.block('sum_init');
  f.const(0).store(3);
  f.const(0).store(2);
  f.jmp('sum_cond');
  f.block('sum_cond');
  f.load(2).const(n).ilt().jz('done');
  f.load(3).load(1).load(2).arrayGet().fadd().store(3);
  f.load(2).const(1).fadd().store(2);
  f.jmp('sum_cond');
  f.block('done');
  f.load(3).ret();
  return b.assemble();
}

test('factorial(5) = 120 with gas charged per block', () => {
  const r = run(factorial(), [5], { gasLimit: GAS });
  assert.equal(r.kind, 'ok');
  assert.equal(r.value, 120);
  assert.ok(r.gasUsed > 0, 'gas must be charged');
  assert.ok(r.blocks > 0, 'blocks must be counted');
});

test('factorial is deterministic: same gas for the same input, twice', () => {
  const prog = factorial();
  const a = run(prog, [7], { gasLimit: GAS });
  const c = run(prog, [7], { gasLimit: GAS });
  assert.equal(a.gasUsed, c.gasUsed);
  assert.equal(a.blocks, c.blocks);
  assert.equal(a.value, 5040);
});

test('sum of 0..9 through the arena = 45', () => {
  const r = run(sumArray(10), [], { gasLimit: GAS });
  assert.equal(r.kind, 'ok');
  assert.equal(r.value, 45);
});

test('array init is charged 2 + N gas, statically', () => {
  const b = new Builder();
  const f = b.fn('alloc_only', 0, 2);
  f.arrayNew(8).store(0);
  f.const(1).ret();
  const r = run(b.assemble(), [], { gasLimit: GAS });
  assert.equal(r.kind, 'ok');
  // one block: ARRAY_NEW(2+8) + STORELOC(1) + CONST(1) + RET(3)
  assert.equal(r.gasUsed, 15);
});

test('out-of-bounds index traps instead of reading neighbours', () => {
  const b = new Builder();
  const f = b.fn('oob', 0, 2);
  f.arrayNew(4).store(0);
  f.load(0).const(99).arrayGet();
  f.ret();
  const r = run(b.assemble(), [], { gasLimit: GAS });
  assert.equal(r.kind, 'trap');
  assert.equal(r.trap, Trap.IndexOOB);
});

test('division by zero traps: there is no infinity in the middle of a program', () => {
  const b = new Builder();
  const f = b.fn('dz', 0, 1);
  f.const(1).const(0).fdiv();
  f.ret();
  const r = run(b.assemble(), [], { gasLimit: GAS });
  assert.equal(r.kind, 'trap');
  assert.equal(r.trap, Trap.DivByZero);
});

test('an over-long array literal is rejected as a length error, not an OOM', () => {
  const b = new Builder();
  const f = b.fn('too_long', 0, 2);
  f.arrayNew(200000).store(0);
  f.const(0).ret();
  const r = run(b.assemble(), [], { gasLimit: GAS });
  assert.equal(r.kind, 'trap');
  assert.equal(r.trap, Trap.BadArrayLen);
});

test('filling the 1 MiB arena traps instead of growing without bound', () => {
  const b = new Builder();
  const f = b.fn('oom', 0, 2);
  f.const(0).store(0); // i = 0
  f.jmp('cond');
  f.block('cond');
  f.load(0).const(40).ilt().jz('done');
  f.arrayNew(4000).store(1); // 4000 elements x 8 bytes = 32 KiB each
  f.load(0).const(1).fadd().store(0);
  f.jmp('cond');
  f.block('done');
  f.const(0).ret();
  const r = run(b.assemble(), [], { gasLimit: GAS });
  assert.equal(r.kind, 'trap');
  assert.equal(r.trap, Trap.OutOfMemory);
});

test('gas exhaustion is a trap, not a hang', () => {
  const prog = factorial();
  const r = run(prog, [20], { gasLimit: 20 });
  assert.equal(r.kind, 'trap');
  assert.equal(r.trap, Trap.OutOfGas);
});

test('metering can be disabled for measurement without changing results', () => {
  const prog = factorial();
  const on = run(prog, [6], { gasLimit: GAS, metering: true });
  const off = run(prog, [6], { gasLimit: GAS, metering: false });
  assert.equal(on.value, off.value);
  assert.equal(on.value, 720);
  assert.ok(on.gasUsed > 0);
  assert.equal(off.gasUsed, 0, 'with metering off no gas is charged by design');
});

test('fib(10) = 55 through the swap in locals', () => {
  const prog = fib();
  assert.equal(prog.fns[0].blockCosts.length, prog.fns[0].blockStarts.length);
  const r = run(prog, [10], { gasLimit: GAS });
  assert.equal(r.kind, 'ok');
  assert.equal(r.value, 55);
});
