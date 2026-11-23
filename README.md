# gascage

A runtime for code written by a model you do not trust.

The idea is one sentence: **the resource bound is proven before the code runs.** Not measured while it runs, not enforced by a timeout — proven, statically, and handed to the VM as the entire budget it is allowed to spend.

```text
source text
   │
   ├─ lexer → parser → typechecker        (gs v0.1)
   │
   ├─ verifier ──▶ REJECT, with a reason  (E_GAS_UNBOUNDED, E_UNBOUNDED_LOOP, ...)
   │      │
   │      └─▶ certificate: gasUpperBound, memoryUpperBound, assumptions
   │
   └─ bytecode → VM (gas charged per block) → block trace → hash → replay
```

"Run it and kill it if it takes too long" is a demo. "Prove it cannot take too long" is a project. Everything below is the second one, including the parts where the proof is weaker than I would like.

---

## Quickstart

```bash
npm install
npm run dev      # pick a program, see ACCEPTED or REJECTED, run it
npm run check    # typecheck + 131 tests + verifier + red-team corpus + claim integrity
```

Node 20+ and npm. No API key, no account, no paid service anywhere in the toolchain.

The dev page is the shortest path to understanding the project: choose a corpus program, read the verdict *before* anything executes, then run it with `gasUpperBound` as the only gas available. If the bound were ever too low, the run would die with `OutOfGas`.

---

## What is actually measured

These numbers come from `npm run check` on this repository and are re-derived on every CI push.

### Verifier soundness

| Metric | Value | How it is established |
|---|---|---|
| Accepted programs that finish inside their proven bound | **10 / 10** | each is executed with the bound as its *entire* gas budget |
| Programs that must be rejected but were accepted | **0** | 10 invalid programs, each must fail with its documented code |
| Valid programs wrongly rejected | **0** | |
| Bounds that are exactly tight (zero slack) | **5 / 10** | |
| Attacks refused before execution | **25 / 25** | `npm run attack` |
| Accepted attacks that stay inside their proven bound | **39 / 39 runs** | adversarial arguments, bound as the only budget |
| Accepted attacks that trap, inside the bound + 1 gas | **2 / 2** | the one gas §9 charges for the trap itself |
| Escapes | **0** | CI fails on the first one |

The tight ones are worth naming, because they are the ones that could not be faked:

```
nested_sweep       585 proven / 585 spent
dot_product        177 / 177
catamaran_plan     114 / 114
slalom_katamaran   175 / 175
battery_used        20 /  20
```

`s.dot(float)` and `min_of` and friends account for the slack in the other five; the loosest bound in the corpus is 12 gas. Average slack: 2.8 gas.

### Red-team result

`corpus/attacks.json` holds 50 programs written to break the verifier rather than to be run. 25 must be refused with a named diagnostic; 23 are legitimate programs that must survive with deliberately hostile arguments (negative parameters, zero iterations, calls through two levels of indirection); 2 must be accepted and allowed to trap, but only inside the proven bound plus the one gas the VM charges for the trap itself. Zero escapes.

Seven of those attacks **worked** against v0.1 before they were written down. They are tagged `regression` in the corpus and each one is now a test:

| Hole | Symptom | Fix |
|---|---|---|
| Callee bound not substituted at the call site | `helper(1000)` proved **43** gas for a program costing ~13,000 | `substitute()` rebinding the callee's form to the caller's arguments; a certificate may only mention its own parameters |
| Unconditional-step rule | `while i < n { if c { i = i + 1 } }` accepted — no progress when `c` is false | one variant analysis (`variant.ts`) shared by checker and verifier: exactly one constant step on every path |
| Multiple steps to the same counter | `i = i + 1; i = i - 1` accepted | the same analysis rejects any second assignment to the counter |
| Loop body priced at the first iteration | `g(i)` inside `while i < 4` priced as `g(0)` | body env invalidated before pricing; arguments bound through the proven counter range |
| Memory bound ignored the arena | 3.2 MB proven for a 1 MiB arena; the run died `OutOfMemory` under a "proven" bound | worst-case memory over parameter maxima, refused with `E_MEMORY` |
| Parameter indices unchecked | `a[n]` read across array boundaries in the arena | `E_INDEX_OOB` unless the index is a literal, a constant variable, or a counter with a proven range inside the length |
| Directional steps | `i = i + 1` in a `>` loop accepted | direction of the step checked against the direction of the condition |

Those are the reason the corpus exists. A verifier that has never been attacked is a hypothesis.

### Runtime cost

| Metric | Value | How |
|---|---|---|
| Cost of one gas check | **≤ 3 ns** (observed 1.55–2.54) | 30M samples of the exact operation |
| VM throughput | 4.0–4.5M loop iterations/s | 1M-iteration loop, min of 11 runs |

### One number I could not measure, and withdrew

Wall-clock metering overhead was supposed to be the headline efficiency claim. On this machine the on/off delta swings between −0.6% and +13.9% across runs — the noise is larger than the ~2.5% effect. Rather than publish whichever end of the range flattered the code, `metering-overhead` is marked **withdrawn** in `bench/claims.json`, and the arithmetic estimate stays in `bench/vm.json` with the spread attached.

The claims table currently reads: **4 measured, 5 not measured, 1 withdrawn.**

---

## Why the language is small on purpose

`gs` v0.1 has no I/O, no clock, no randomness, no recursion, and fixed-size arrays. That is not laziness, it is what makes the two central properties provable instead of merely plausible:

- **Determinism.** Same program, same arguments → same result, same trap, same block trace. Verified by hashing the trace with FNV-1a and comparing runs.
- **Boundedness.** Without recursion and without unbounded allocation, every function has a computable cost as a function of its parameters.

Effects arrive later as capabilities passed explicitly to the function, so ambient authority stays at zero. Until then the language is a pure calculator, which is exactly the shape a verifier can reason about.

A whole program:

```rust
fn slalom_katamaran(wind: f64, gust: f64) -> i32 {
  let i: i32 = 0;
  let steps: i32 = 0;
  while i < 8 {
    if wind + gust > 12.0 {
      steps = steps + 1;
    }
    i = i + 1;
  }
  return steps;
}
```

Four basic blocks. Accepted because the verifier can see `i` walking to 8. Change the body to `i = i + 0` and it is rejected with `E_UNBOUNDED_LOOP` without a single instruction being executed.

---

## How the bound is proven

The verifier is a structural cost model, not an SMT solver — that distinction matters, so it is stated here rather than buried.

- **Gas is charged per basic-block entry**, not per instruction. The assembler attaches a cost to every block; the VM only adds and compares. This is what turns "how much did it cost" into "how many times can each block run".
- **The cost model mirrors the lowering instruction for instruction**, so `Σ cost(block) × visits(block)` equals actual gas. The corpus test exploits that directly by making the proven bound the only budget.
- **Loop counts** come from constant propagation on counters. A literal limit gives an exact trip count; a parameter limit gives a linear form (`p/step + 1`). Branches are combined componentwise with max, which is sound because coefficients are non-negative.
- **Reject by default.** A counter not initialised to a constant, a product of two parameter-dependent forms, or any recursion is `E_GAS_UNBOUNDED`. The verifier never guesses in the program's favour.

The rule that made this trustworthy is in `docs/spec-v0.2-isa.md`: **a basic block never contains instructions from two different control-flow paths.** Three real bugs came from violating it early — unreachable `return` sharing a block with a constant, a loop body starting inside the condition block — and each one made the proven bound *lower* than the real cost. The "run with the bound as the only budget" test is the only reason they were caught before anything was published.

---

## The rule the repository is built around

`bench/claims.json` is the only place a number about this project may appear, and a claim may carry a value **only if CI reproduces it**.

- `npm run bench` fails if a claim is published without a measurement, or measured without a claim.
- The landing page renders the table straight from that file, so the UI cannot advertise something the code has not measured.
- A claim that cannot be reproduced is moved to `withdrawn`, not quietly rounded.

There is no separate marketing copy to drift out of sync, because there is no marketing copy.

---

## Limitations

Read this part before the roadmap.

- **No SMT solver.** Loops whose variant is not a single counter are rejected rather than analysed. Z3 is planned for the residual obligations, not implemented.
- **Conservative, by construction.** Anything the cost model cannot express is refused, not approximated: a call whose argument is not a constant, a parameter or a bounded counter; a loop whose counter is reset on one path; an index that is not a literal or a proven counter. The memory bound is worst-case over parameter maxima, so it can reject a program that would be fine for the specific arguments you had in mind. That is the price of the bound being a proof rather than a guess.
- **No cross-engine determinism yet.** Traces are deterministic within the one JS engine. The stronger claim — two independent implementations producing identical trace hashes — waits for the Rust VM.
- **No capabilities.** The sandbox has no ambient authority because the language cannot perform effects at all. That is a weaker statement than "the sandbox is secure" and should be read as such.
- **The UI is one panel.** Pick a program, read a verdict, run it. No editor, no trace viewer.
- **Windows measurement noise.** The timing numbers above are from this machine; they should be re-measured on yours before being believed.

---

## Status

| Milestone | Delivers | State |
|---|---|---|
| S0 | project skeleton, CI, claim-integrity harness | done |
| S1 | language spec v0.1, 20-program conformance corpus | done |
| S2 | stack VM, block-level gas metering, ISA | done |
| S3 | lexer → parser → typechecker → bytecode, 20/20 conformance | done |
| S4 | deterministic block traces and replay | done |
| S5 | verifier: proven gas and memory bounds | done |
| S6a | red-team corpus: 50 attacks, 0 escapes | done |
| S6b | capabilities (`module f(caps: wind, clock)`), 100-attack corpus | planned |
| S7 | LLM front-end with grammar-constrained decoding | planned |
| S8 | Rust VM, cross-engine trace comparison | planned |
| S9 | public escape challenge | planned |

S0–S6a are closed: 131 tests, 10/10 corpus conformance, 50 attacks with zero escapes, zero unproven numbers published. S6b–S9 are additive.

---

## Repository layout

```
src/core/isa.ts         instruction set, gas table, handle encoding
src/core/program.ts     assembler; attaches cost to each basic block
src/core/vm.ts          the VM: arena, gas counter, nine traps
src/core/{lexer,parser,check,lower,compiler}.ts   gs v0.1 front-end
src/core/cost.ts        linear cost forms over parameters
src/core/variant.ts     the one loop-variant rule, shared by check and verify
src/core/verify.ts      the verifier and its certificate
src/core/trace.ts       deterministic block trace, FNV-1a hashing
src/core/harness.ts     compile → verify → run, used by tests and the UI

corpus/examples.json    10 valid programs with expected results,
                        10 invalid programs with expected error codes
corpus/attacks.json     50 attacks: 25 refused, 23 contained, 2 may trap
bench/claims.json       every published number, and nothing else
docs/spec-v0.1.md       the language: grammar, types, determinism, gas
docs/spec-v0.2-isa.md   the machine: blocks, instructions, traps
docs/PLAN.md            S0–S10 with gates and the notes on what changed
scripts/                test runner, verifier and red-team drivers, two benchmarks
tests/                  node:test suites
```

## Free by construction

Nothing here needs a paid API:

- **Generation (S7):** a local model via Ollama or `llama.cpp`, which also gives GBNF grammar-constrained decoding for free, or an in-browser WebGPU model. Optional free-tier OpenAI-compatible endpoints go behind a proxy so the key never reaches the client.
- **Tooling:** Node, Vite, TypeScript; Rust and Z3 when S8 and S5b need them.
- **Verification:** the corpus is JSON. No service is involved.

## Reading order

1. `docs/spec-v0.1.md` — what the language is and why it is pure
2. `src/core/verify.ts` — the core claim, in ~300 lines
3. `corpus/examples.json` — what "correct" means, program by program
4. `docs/PLAN.md` — where this goes, and which parts are still guesses
