# gascage ISA v0.2 (draft)

The bytecode the S2 VM executes. Matches `src/core/isa.ts` and the gas table in
[`spec-v0.1.md`](spec-v0.1.md) §9. Anything not written here is not promised.

## Model

- Stack machine. Every slot is 8 bytes: one `f64` bit pattern. Integers and
  booleans are **stored as exactly-representable numbers** (`|x| ≤ 2^53`);
  integer range checks are enforced by the integer opcodes, not by the container.
- Code is one flat `Instr[]` per function. `pc` indexes it.
- Locals live in a per-frame `Float64Array(localCount)`. Parameters occupy
  slots `0..paramCount-1`; the caller pushes arguments in order and `CALL` pops
  them into the callee's slots.
- One arena per instance, `Float64Array(arenaElements)`, bump-allocated, never
  freed in v0.2 (arrays are statically sized, so lifetime analysis is deferred).

## Instructions

| # | Mnemonic | Immediates | Stack | Gas |
|---|---|---|---|---|
| 0 | `ENTER` | block index | — | 0 (+ meters the block) |
| 1 | `CONST` | `f64` | → `v` | 1 |
| 2 | `LOADLOC` | slot | → `locals[slot]` | 1 |
| 3 | `STORELOC` | slot | `v` → | 1 |
| 4 | `FADD` | | `a b` → `a+b` | 1 |
| 5 | `FSUB` | | `a b` → `a-b` | 1 |
| 6 | `FMUL` | | `a b` → `a*b` | 1 |
| 7 | `FDIV` | | `a b` → `a/b` | 2 |
| 8 | `IDIV` | | `a b` → trunc(`a/b`) | 3 |
| 9 | `IMOD` | | `a b` → `a-trunc(a/b)*b` | 3 |
| 10–15 | `ILT ILE IGT IGE IEQ INE` | | `a b` → `0/1` | 1 each |
| 16 | `JMP` | pc | — | 1 |
| 17 | `JZ` | pc | `v` → | 1 |
| 18 | `CALL` | fn index, argc | `args` → | 5 |
| 19 | `RET` | | `v` → (`v` to caller) | 3 |
| 20 | `HALT` | | `v` → | 1 |
| 21 | `ARRAY_NEW` | N | → handle | `2 + N` |
| 22 | `ARRAY_GET` | | handle idx → `v` | 3 |
| 23 | `ARRAY_SET` | | handle idx `v` → | 3 |
| 24 | `CAST` | target: 0=i32, 1=i64, 2=f64 | `v` → `v'` | 1 |
| 25 | `SQRT` | | `x` → `sqrt(x)` | 8 |
| 26 | `FABS` | | `x` → `abs(x)` | 2 |
| 27 | `FMIN` | | `a b` → `min(a,b)` | 2 |
| 28 | `FMAX` | | `a b` → `max(a,b)` | 2 |
| 29 | `IADD` | width: 32 or 64 | `a b` → `a+b` | 1 |
| 30 | `ISUB` | width: 32 or 64 | `a b` → `a-b` | 1 |
| 31 | `IMUL` | width: 32 or 64 | `a b` → `a*b` | 1 |
| 32 | `POP` | | `v` → | 1 |

Trap costs 1 and is charged before the trap is raised.

`IADD`/`ISUB`/`IMUL` carry the width as an immediate instead of splitting into six
opcodes: the compiler knows the static type, the VM only needs the range check.
Width 32 enforces `i32` bounds; width 64 enforces the exactly-representable range
(`|x| ≤ 2^53`), which is this VM's documented `i64` limitation. Both trap on overflow
rather than wrapping, per spec D6.

## Handles

An array handle packs both halves of the descriptor into one exact `f64`:

```
handle = ptr * 4096 + len        // ptr, len < 4096, arena ≤ 131072 elements
ptr    = floor(handle / 4096)
len    = handle % 4096
```

`HANDLE_BASE = 4096` is the modulus, so the longest array in v0.2 is **4095**
elements (a length equal to the base would decode as the next `ptr`). That, plus
the 131072-element arena, is what makes the 1 MiB cap hold by construction. No handle can
name memory outside the arena, and no arithmetic on a handle can produce a
valid-looking handle for a different object without the bounds check seeing it.

## Block discipline (a correctness rule for the compiler)

Gas is charged on **block entry**, so a block is charged in full even when a branch
leaves it early. Two rules follow, and both are enforced by tests:

1. A block never contains instructions belonging to two control paths. Every `if` arm,
   every loop body and every function tail starts its own block. Otherwise an
   unreachable instruction still costs gas, and the verifier's bound silently breaks
   (it did: `return` used to share a block with the appended `CONST 0; RET`).
2. Consequence: `gas = Σ instructions executed`, which is what makes the cost model in
   `src/core/verify.ts` checkable against the VM instead of aspirational.

## Metering

Each block starts with `ENTER`, whose `a` field is the block index. The
assembler computes `blockCosts[i] = Σ instructionCost(instr)` for that block and
**excludes `ENTER` itself**, so metering is a pure function of the stream:

```
if (gasLeft < blockCosts[b]) trap(OutOfGas)
gasLeft -= blockCosts[b]
```

Consequences: overshoot is bounded by `max_b blockCosts[b]`; the exhaustion point
is identical on every engine; and no path can charge a partial block. Disabling
metering (`metering: false`) skips this check entirely and is used only to
measure its cost — a gas-less run reports `gasUsed = 0` by design.

## Traps

`DivByZero`, `IndexOOB`, `OutOfMemory`, `OutOfGas`, `StackOverflow`,
`IntOverflow` (integer overflow, or an integer op on a non-integer),
`DomainError` (`sqrt` of a negative value, spec D4), `BadCast` (out-of-range cast),
`BadArrayLen`, `BadCall` (arity/index/depth), `NoHalt` (fell off the end of a function).

Traps are returned, never thrown. A trap on an accepted program is a verifier
bug, and the trace records it as such.

## Deliberate limits of this draft

- `i64` is limited to `2^53 - 1` in the TypeScript VM; the Rust VM (S8) will
  carry true 64-bit words. The verifier must not certify a program whose bound
  depends on the difference.
- `sqrt`/`abs`/`min`/`max` exist for `f64` only; integer overloads wait on the
  verifier defining how `abs(i32::MIN)` is rejected.
- No byte encoder yet. Programs are built with the assembler; a binary encoding
  lands when the trace format needs stable program hashes.
