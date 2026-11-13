# gascage

A runtime for code written by an unreliable model: **the gas bound is proven before the code runs**, the sandbox has no ambient authority, and execution is deterministic enough to replay bit-for-bit.

```text
natural language → LLM (+grammar) → AST → typed HIR
   → VERIFIER (bounds + gas proof) ──▶ reject, with a reason
   → bytecode → WASM VM in a Worker → capability grants → trace
```

The interesting half is the verifier. "Run it and kill it if it takes too long" is a demo; "prove it cannot take too long" is the project.

## Status

| Milestone | What it delivers | State |
|---|---|---|
| S0 | skeleton, CI, claim-integrity bench harness | **done** |
| S1 | language spec v0.1 + 20-program conformance corpus | **done** |
| S2 | stack VM, gas metering at basic-block granularity, ISA v0.2 | **done** |
| S3 | lexer → parser → typechecker → bytecode, 20/20 corpus conformance | **done** |
| S4 | deterministic block traces + replay (one engine; cross-engine with the Rust VM in S8) | **done** |
| S5 | verifier: proven gas and memory bounds (**the core claim**) | **done** |
| S6 | capabilities + 100-attack red-team corpus | next |
| S7 | LLM front-end with constrained decoding | |
| S8 | WASM backend + honest perf table | |
| S9 | public escape challenge | |

Full plan: [`docs/PLAN.md`](docs/PLAN.md). Language: [`docs/spec-v0.1.md`](docs/spec-v0.1.md). Bytecode: [`docs/spec-v0.2-isa.md`](docs/spec-v0.2-isa.md).

### The language in one program

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

This compiles to bytecode with four basic blocks, and it is accepted only because the
compiler can see that `i` walks to 8: a loop whose counter does not move is rejected with
`E_UNBOUNDED_LOOP` *before anything runs*. All 10 valid corpus programs run to a checked
result and all 10 invalid ones are rejected with their exact documented code (`npm test`).

### First measured numbers (S2)

| Metric | Value | How |
|---|---|---|
| VM throughput | 4.0–4.5M iterations/s, 36–41M instructions/s | 1M-iteration loop, min of 11 runs |
| Cost of one gas check | **≤ 3 ns** (observed 1.78–2.54) | 30M-sample microbenchmark of the exact operation |
| Metering overhead at 3 blocks / 9 instructions | ~2.5% arithmetic estimate | `3 × checkNs / nsPerIteration` |

### The verifier (S5), measured

| Metric | Value | How |
|---|---|---|
| Accepted corpus programs that ran inside their proven bound | **10/10 (100%)** | each run got the bound as its *entire* gas budget |
| Programs that must be rejected but were accepted | **0** | `npm run verify` |
| Programs whose bound is exact (zero slack) | **5/10** | loops dominate; straight-line code has 4–12 gas of slack |

The interesting column is the third. `nested_sweep` proves 585 gas and spends 585. `dot_product` proves 177 and spends 177. A bound that is the only thing keeping the program alive cannot be hand-waved.

One claim did not survive contact with the harness. Wall-clock on/off deltas on this machine swing from −0.6% to +13.9% between runs, so a 2.5% effect cannot be resolved, and publishing whichever end of that range looked best would have been dishonest. `metering-overhead` is therefore marked **withdrawn** in `bench/claims.json`, and only the stable number — the 3 ns upper bound on a single gas check — is claimed. The arithmetic estimate stays in `bench/vm.json` with the spread attached.

## Quickstart

```bash
npm install
npm run dev      # landing page with the live claims table
npm run check    # typecheck + tests + claim integrity
```

## The rule this repo is built around

`bench/claims.json` is the only place a number may appear, and a claim may carry a number **only if CI reproduces it**. `npm run bench` fails the build if that invariant is broken, and the landing page renders the table straight from that file — so the UI cannot advertise something the code has not measured. Today every claim is `not_measured`, which is the honest state of the project.

## Everything here is free

No paid API is required at any point:

- **Generation:** a local model (Ollama or `llama.cpp` server, which also gives us GBNF grammar-constrained decoding for free), or an in-browser WebGPU model. Optional free-tier OpenAI-compatible endpoints behind a tiny proxy — the key never ships to the client.
- **Tooling:** Node, Vite, TypeScript, Rust, Z3, Lean 4 — all free and open source.
- **Verification:** the conformance corpus is JSON; no paid service touches it.

## Layout

```
src/            React app (landing page, later: editor + trace viewer)
src/core/       shared types; the compiler, verifier and VM land here
docs/           spec, plan
corpus/         conformance suite (10 valid, 10 rejected with a specific code)
bench/          claims.json (source of truth for every published number)
scripts/        bench harness
tests/          node:test suites enforcing the corpus and claim invariants
```
