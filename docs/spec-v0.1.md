# gascage — Spec v0.1

**Status:** draft, frozen for S2/S3. Changes require a corpus update and a version bump.
**Scope:** source language `gs`, its types, its memory model, its gas model, and the contract the verifier must satisfy. Bytecode ISA is deferred to v0.2.

---

## 1. What this language is for

`gs` is the target of a model's code generation, not a language people write for fun. Every design decision below optimises for three properties, in this order:

1. **Provability.** The verifier must be able to prove a finite gas bound and memory-safety *before* execution. Anything that makes that proof undecidable is cut.
2. **Determinism.** Two conforming engines must produce bit-identical traces. Anything platform-dependent is cut.
3. **Small surface.** A smaller language is a smaller attack surface and a smaller proof obligation.

The result is deliberately austere. That is the point: the interesting engineering is in the verifier, not in syntax sugar.

## 2. Non-goals for v0.1

Cut on purpose, each with a reason:

| Feature | Why it is cut in v0.1 |
|---|---|
| Recursion | Needs a decreasing-measure proof to bound the stack and the gas. Deferred to v0.3. |
| Strings / text | No proven memory model yet, and model-generated text handling is where ReDoS lives. |
| Closures, higher-order functions | Escape analysis required to keep the memory bound static. |
| Dynamic arrays, `Vec`, `HashMap` | Unbounded growth = unbounded gas. Fixed `[T; N]` only. |
| Implicit numeric conversions | Ambiguity in lowering; all casts are explicit `as`. |
| Any I/O, clock, randomness | v0.1 is **pure** (see §7). Effects arrive as capabilities in v0.2. |
| Pointers, `unsafe`, FFI | Not expressible at all. |
| Exceptions, `try/catch` | Control flow must be statically enumerable for gas counting. Traps are fatal, not catchable. |
| Global mutable state | Removes inter-procedural reasoning about memory and gas. |

## 3. Lexical structure

- Source is UTF-8; identifiers are ASCII `[A-Za-z_][A-Za-z0-9_]*`.
- Line comment: `// …` to end of line. No block comments (nesting bugs are a classic parser CVE).
- Integer literals: decimal, optional `_` separators. Suffix required when the type is not inferable from context: `10i32`, `10i64`. Bare `10` is context-typed.
- Float literals: decimal with `.` and/or exponent; `1.0`, `2.5e-3`. Always `f64`.
- Booleans: `true`, `false`.
- Keywords: `fn let set if else while return as true false i32 i64 f64 bool unit`.
- Whitespace is insignificant; no automatic semicolon insertion.

## 4. Grammar (EBNF)

```ebnf
program     = { fn_decl } EOF ;
fn_decl     = "fn" IDENT "(" [ params ] ")" "->" type block ;
params      = param { "," param } ;
param       = IDENT ":" type ;

type        = "i32" | "i64" | "f64" | "bool" | "unit" | array_type ;
array_type  = "[" type ";" INT "]" ;

block       = "{" { stmt } "}" ;
stmt        = let_stmt | set_stmt | if_stmt | while_stmt | return_stmt | expr_stmt ;
let_stmt    = "let" IDENT ":" type "=" expr ";" ;
set_stmt    = IDENT "=" expr ";" ;
if_stmt     = "if" expr block [ "else" block ] ;
while_stmt  = "while" expr block ;
return_stmt = "return" [ expr ] ";" ;
expr_stmt   = expr ";" ;

expr        = bin_expr ;
bin_expr    = un_expr { binop un_expr } ;      // left-associative, see precedence
un_expr     = [ "-" | "!" ] postfix ;
postfix     = primary { "[" expr "]" } ;
primary     = INT | FLOAT | "true" | "false"
            | IDENT [ "(" [ args ] ")" ]
            | "(" expr ")"
            | "(" expr "as" type ")"
            | array_lit ;
array_lit   = "[" expr { "," expr } "]"        // length-inferred
            | "[" expr ";" INT "]" ;           // repeat form

binop       = "+" | "-" | "*" | "/" | "%"
            | "<" | "<=" | ">" | ">=" | "==" | "!="
            | "&&" | "||" ;
args        = expr { "," expr } ;
```

**Precedence**, tightest first: `* / %` → `+ -` → `as` → `< <= > >=` → `== !=` → `&&` → `||`. `&&`/`||` short-circuit (§7). No unary `+`.

**Well-formedness:** every `fn` is top-level; no overloading; names are unique per module; a `let` always has both a type and an initialiser (there is no uninitialised `let`); `set` may only target an existing `let` binding of exactly the same type.

## 5. Types and typing rules

Types: `i32`, `i64`, `f64`, `bool`, `unit`, and `[T; N]` for a compile-time constant `N ≥ 1`.

Judgement form: `Γ ⊢ e : τ`. `Γ` maps names to types (locals plus top-level functions).

```
─────────────    n fits in i32
Γ ⊢ 10 : i32

Γ(x) = τ
──────────
Γ ⊢ x : τ

Γ ⊢ e1 : τ    Γ ⊢ e2 : τ    τ ∈ {i32,i64,f64}       (⊕ is + - * / %)
─────────────────────────────────────────────
Γ ⊢ e1 ⊕ e2 : τ

Γ ⊢ e1 : τ    Γ ⊢ e2 : τ    τ ∈ {i32,i64,f64}       (⋈ is < <= > >=)
─────────────────────────────────────────────
Γ ⊢ e1 ⋈ e2 : bool

Γ ⊢ e : bool    Γ ⊢ s1 : unit    Γ ⊢ s2 : unit
──────────────────────────────────────────────
Γ ⊢ (if e s1 else s2) : unit

Γ ⊢ e : [T; N]    Γ ⊢ i : i32          (i64 accepted, §5.1)
──────────────────────────────────
Γ ⊢ e[i] : T

Γ ⊢ e : i32|i64|f64    cast allowed by §5.2
────────────────────────────────────────
Γ ⊢ (e as τ') : τ'

Γ ⊢ f : (τ̄) -> τ    Γ ⊢ ā : τ̄   (component-wise, exact)
──────────────────────────────────────────────────────
Γ ⊢ f(ā) : τ
```

### 5.1 No implicit conversions

`1 + 2.0` is `E_TYPE_MISMATCH`. There is no numeric tower coercion, no integer widening, no `bool`↔`i32`. Array indices must be `i32` or `i64`; `a[1.5]` is `E_INDEX_TYPE`.

### 5.2 Casts

Allowed: `i32→i64`, `i32→f64`, `i64→f64`, `f64→i32`, `i64→i32`, `i32→i64`. Everything else is `E_TYPE_MISMATCH`.

- `→f64`: exact for `i32`; rounded to nearest-even for `i64` values above 2^53.
- `f64→i32/i64`: truncates toward zero; **traps** if the value is NaN, infinite, or outside the target range.

There are no casts to or from `bool` or arrays.

### 5.3 Return discipline

Every function body must return on all paths (`E_MISSING_RETURN`). `unit` functions may fall off the end. Falling off a non-`unit` function is impossible by construction, so the VM never needs a fall-through handler.

### 5.4 Builtins

Four builtins are in scope, all `f64` in v0.1: `sqrt(x)`, `abs(x)`, `min(a, b)`, `max(a, b)`.
They are priced from §9 (8, 2, 2, 2) and are the only nameable functions that are not declared in the module.
Integer overloads are deferred: adding them means deciding whether `abs` traps on `i32::MIN`, and that decision belongs with the verifier in S5.
A model that calls `abs` on an `i32` gets `E_TYPE_MISMATCH`, not a silent widening — the same rule as every other operator.

## 6. Memory model

- **One arena per instance**, sized at instantiation, hard cap `1 MiB` in v0.1.
- Locals live in a fixed frame: each `let` gets a slot at its declaration site; `i32`/`bool`/`f64` are 8 bytes in the frame regardless of type (uniform slots, no packing).
- An array value is `{ptr: u32, len: u32}` (8 bytes). The arena stores elements contiguously, 8 bytes each.
- Arrays are **fixed length**. There is no resize and no `push`. v0.1 also has **no element assignment**: the grammar defines no `a[i] = v` statement, so arrays are built from literals only. The ISA reserves `ARRAY_SET` for v0.2, where the statement form is added together with the bounds proof that makes it safe.
- **No pointer is ever exposed as a value.** The source language has no address-of operator; the only way to reach memory is a bounds-checked index.
- **Zero initialisation.** The arena is zeroed at instantiation. Combined with mandatory `let` initialisers, there is no uninitialised read.
- **Allocation is static.** Every array expression's size is known at compile time, so `memory_upper_bound` is a compile-time constant: the sum of all array sizes a function can instantiate, times maximum loop multiplicity.
- **Frame depth cap 64.** Exceeding it traps (`Trap::CallDepth`). With recursion banned (§11 O4) this is unreachable in accepted programs; it stays as a runtime backstop.

## 7. Evaluation semantics

v0.1 is **pure**. That single decision is what makes determinism and resource bounds tractable:

- No I/O, no clock, no randomness, no environment reads.
- A function's result depends only on its arguments.
- Therefore a trace is fully determined by `(program hash, arguments, gas limit)`.

**Evaluation order:** strictly left-to-right, in both operands and array literal elements. `&&`/`||` short-circuit: the right operand is evaluated only if the left does not decide the result.

Small-step core (configuration `⟨e, σ, g⟩`; `σ` is the store, `g` remaining gas):

```
             σ(x) = v
        ────────────────────
        ⟨x, σ, g⟩ → ⟨v, σ, g⟩

   ⟨e1, σ, g⟩ → ⟨e1', σ1, g1⟩
─────────────────────────────────────
⟨e1 ⊕ e2, σ, g⟩ → ⟨e1' ⊕ e2, σ1, g1⟩

       v = v1 ⊕ v2   (no trap)
──────────────────────────────────
⟨v1 ⊕ v2, σ, g⟩ → ⟨v, σ, g - c(⊕)⟩

        v2 = 0    (with ⊕ ∈ {/, %})
─────────────────────────────────────
⟨v1 ⊕ v2, σ, g⟩ → TRAP(DivByZero)

       i < 0  or  i ≥ N
──────────────────────────────
⟨a[i], σ, g⟩ → TRAP(IndexOOB)
```

`let x: T = v;` extends `σ` with `x ↦ v` and charges the local-store cost. `set x = v;` replaces the binding. `if` and `while` are structural: `while c b` re-evaluates `c` before each iteration; it is not sugar for `loop`, and it has no `break`/`continue`.

**Traps are fatal and uncatchable.** An accepted program must not trap for any argument in the domain the verifier certified. A trap means the verifier's proof was wrong — that is a bug in *our* tool, reported as such, not a normal control-flow path.

## 8. Determinism contract

Two conforming engines must produce identical traces. Binding rules:

| # | Rule |
|---|---|
| D1 | `f64` is IEEE-754 binary64, round-to-nearest-even. No fast-math, no fused multiply-add contraction. |
| D2 | Every produced NaN has the canonical bit pattern `0x7FF8000000000000`. NaN payloads never propagate. |
| D3 | `min`/`max` builtins: if either argument is NaN the result is the canonical NaN; `min(-0.0, 0.0) = -0.0`, `max(-0.0, 0.0) = 0.0`. |
| D4 | The core exposes only correctly-rounded builtins: `abs`, `min`, `max`, `sqrt`. `sqrt` of a negative value is a trap, not NaN. |
| D5 | Transcendentals (`sin`, `cos`, `exp`, `ln`, `pow`) are **not in the core**. They live in a versioned `math` capsule with a bit-exact implementation; using them requires naming the capsule version in the module header. |
| D6 | Integer overflow traps: `+`, `-`, `*`, unary `-`, and `i32::MIN / -1` all trap on overflow rather than wrapping. |
| D7 | Division or remainder by zero traps for every numeric type, including `f64`. There is no `inf` in a `gs` program that did not come from a literal. |
| D8 | Traces contain no addresses, no timings, no pointer values. They contain instruction indices and values only. |
| D9 | Gas is charged at basic-block entry as a single check (§10), so gas-exhaustion points are identical across engines. |

Rationale: D5 exists because `Math.sin` is *not* bit-identical across V8, SpiderMonkey and wasm libm. Any spec that quietly assumes otherwise cannot claim determinism across engines.

## 9. Gas model

Gas is an abstract unit: `1` unit is one dispatch of the cheapest instruction. Costs (fixed by this version; a change is a spec bump):

| Operation | Gas |
|---|---|
| `const`, local load, local store | 1 |
| `i32`/`i64` `+ - *`, comparisons, `&&`, `\|\|`, `!` | 1 |
| `i32`/`i64` `/`, `%` | 3 |
| `f64` `+ - *` | 1 |
| `f64` `/` | 2 |
| `abs`, `min`, `max` | 2 |
| `sqrt` | 8 |
| array index load (bounds check included) | 3 |
| array index store (bounds check included) | 3 |
| array init, `N` elements | `2 + N` |
| `call` (frame setup) | 5 |
| `ret` (frame teardown) | 3 |
| conditional branch (compare + jump) | 2 |
| unconditional jump | 1 |
| trap | 1 (charged before the trap is raised) |
| halt | 1 |

**Metering granularity: basic block.** Each block's cost `c(b)` is a compile-time constant (sum of its instruction costs). On entry:

```
if gas_left < c(b) then TRAP(OutOfGas) else gas_left -= c(b)
```

Consequences the verifier depends on:

1. Overshoot is bounded by `max_b c(b)`, a compile-time constant. Gas accounting is therefore exact within one block — no per-instruction check is needed, which is where the 5–30% overhead figure comes from.
2. A block never traps *in the middle* of its cost accounting. Two engines agree on the exhaustion point because they agree on block boundaries (D9).
3. `gas_upper_bound` is a static quantity: `Σ_b c(b) × multiplicity(b)` where `multiplicity` comes from loop-bound inference (§11 O3).

## 10. Trace format

An append-only binary record stream, per instance:

```
header:  magic "GSC1" | spec version | program hash (32B) | arena size | gas limit | arg block
record:  u8 kind | u32 block_index | payload
kinds:   BLOCK, TRAP(kind), HALT(result bytes), ARG(i), CALL, RET
```

Replay = execute from the header. Determinism (D1–D9) means the trace hash is a sound equality check: equal hash ⟺ same execution, which is why the S4 fuzzer compares hashes across engines instead of comparing logs.

## 11. Verifier contract

Input: a typechecked function. Output: `accept(certificate)` or `reject(code, detail)`. Obligations, all mandatory:

| # | Obligation | Failure code |
|---|---|---|
| O1 | Program typechecks under §5 | `E_TYPE_MISMATCH` / `E_ARITY` / … |
| O2 | Every index `a[i]` is provably within `[0, N)` for all executions reaching it | `E_INDEX_OOB` |
| O3 | Every loop has a variant function strictly decreasing over a well-founded order, giving a finite iteration bound `K` | `E_UNBOUNDED_LOOP` |
| O4 | The call graph is acyclic (no recursion, direct or indirect) | `E_RECURSION` |
| O5 | `memory_upper_bound ≤ 1 MiB` | `E_MEMORY` |
| O6 | `gas_upper_bound` is finite and ≤ the configured limit | `E_GAS_UNBOUNDED` |

The verifier is **reject-by-default**: if an obligation cannot be discharged, the program does not run. It is not "run with a timer and hope".

Certificate:

```json
{
  "fn": "slalom_katamaran",
  "obligations": ["O1", "O2", "O5", "O6"],
  "gasUpperBound": 174,
  "memoryUpperBound": 0,
  "loops": [{ "block": "b3", "bound": 8, "variant": "8 - i" }],
  "tool": { "verifier": "gascage-verify 0.1.0", "solver": "z3 4.13.0" }
}
```

The certificate is the artifact the UI shows and the escape challenge publishes. It is also what makes the central claim falsifiable: run any accepted program, compare actual gas to `gasUpperBound`. One counterexample invalidates the claim.

### 11.1 Method actually implemented (v0.1)

No SMT solver is used yet, and this document says so rather than implying otherwise.

- **Cost model.** The verifier mirrors the lowering instruction for instruction, and the
  lowering is required by §9 and the ISA's block discipline to charge gas per block entry.
  Together that makes `gas = Σ executed instruction costs`, which the suite checks directly:
  every accepted corpus program is executed with its proven bound as the *entire* gas budget.
  A single undercount traps with `OutOfGas` and fails the build.
- **Loop counts.** Counters are tracked with constant propagation through `let`/`set`.
  `while v < K` with a literal `K` yields an exact trip count; a parameter limit yields a
  linear form (`K = p/step + 1`). Minimums and maximums over branches use componentwise
  max, which is sound because coefficients are non-negative.
- **Soundness at instantiation.** A symbolic trip count is `p/step`, which is negative for
  `p < 0` while the true count is zero. `instantiate` therefore uses `|p|`: still linear, still
  an upper bound for every sign, deliberately loose for negative arguments.
- **Refusals.** A product of two parameter-dependent forms is rejected (`E_GAS_UNBOUNDED`)
  rather than linearised, and a counter that is not constant-initialised is rejected too.

Measured on the v0.1 corpus: 10/10 accepted programs run inside their bound, 0 programs that
must be rejected are accepted, and 5/10 bounds are exactly tight (zero slack). Residual work is
SMT-backed reasoning for loops whose variant is not a single counter — see §15.

### 11.2 Red-team corpus (S6)

Soundness that has never been attacked is a hypothesis. `corpus/attacks.json` is the adversary:
50 programs whose only purpose is to obtain a certificate they do not deserve. `npm run attack`
enforces two rules, and CI runs it on every push.

- **refused before execution** — the verifier must return the named diagnostic. Accepting one of
these is an escape.
- **contained** — the program is legitimate, so it is accepted, and then executed with the proven
bound as its *entire* gas budget under adversarial arguments (negative parameters, zero
iterations, indirect calls). Trapping there is also an escape.

Measured: 25 refused, 39 accepted runs contained, 2 accepted-and-trapping runs inside the bound plus the surcharge, 0 escapes. The corpus is deliberately hard to
satisfy from both sides — a verifier that rejects everything fails the 39 contained runs.

Seven attacks defeated v0.1 before they were written down. The rule each violation broke, and
what now enforces it:

| # | Violation | Enforcement |
|---|---|---|
| A1 | A callee's bound was charged at the call site unsubstituted, so its parameter terms were read as zero and gas was undercounted by the whole cost of the callee's loops | `cost.substitute` rebinds to argument forms (constants, parameters, linear combinations, or the proven range of a loop counter); anything else is `E_GAS_UNBOUNDED`. `seal` refuses a certificate that mentions a parameter that is not its own |
| A2 | A step inside one `if` arm counted as progress for the whole body | O3 is decided by `variant.ts`: exactly one constant step, guaranteed on every path |
| A3 | Two steps to the same counter (`i = i + 1; i = i - 1`) were treated as one | same analysis: a second assignment to the counter refuses the loop |
| A4 | A loop body was priced using the constant values of its *first* iteration, so `g(i)` was priced as `g(0)` | the body environment is invalidated before pricing; counters are recovered from the proven range, not from a stale constant |
| A5 | The memory bound was never compared to the arena, so an accepted program could trap `OutOfMemory` under its own bound | O5 is checked over parameter maxima; worst-case allocation above 1 MiB is `E_MEMORY` |
| A6 | Indices were only checked when literal, so `a[n]` could read across array boundaries in the arena | O2 requires a literal, a constant variable, or an induction variable with a proven range inside the length |
| A7 | A step's sign was not checked against the condition, so `i = i + 1` inside `while i > k` counted | direction of the step must match the direction of the condition |

A4 is the instructive one: O1–O6 were all nominally discharged, and the certificate was still
short. The lesson recorded here is that a cost model is only as sound as the *environment* it is
evaluated in, not just the instructions it adds up.

### 11.3 What the certificate guarantees, precisely

For an accepted function `f` with parameters `p̄` and any argument vector `ā` of the declared
types that does not trap arithmetically, `f` terminates and spends at most
`instantiate(gas, ā)` gas and allocates at most `instantiate(memoryBytes, ā)` bytes. Arithmetic
traps remain visible: a program that divides by zero at runtime traps, and that trap is not
predicted by the certificate. The bound is an upper bound on *completed* executions, not a
promise that every execution completes without a trap.

A trapping execution is bounded too, at `instantiate(gas, ā) + 1`: §9 charges one gas for the trap
itself before raising it, so metering stays monotone through a trap. That surcharge is the reason
the corpus distinguishes `traps` from `contained` — two programs in it are accepted, are allowed
to trap, and are required to do so within the bound plus exactly that one gas.

## 12. Capabilities (v0.2 preview, model fixed now)

v0.1 is pure, so no capability is reachable. The model is nonetheless fixed now so the compiler is built for it:

- Functions are pure by default. Effects exist only through **capsules** named in the module header: `module plan(caps: wind, clock)`.
- A capsule is an explicit, versioned, gas-priced interface. Each call declares its gas cost, so the verifier can fold effects into `gas_upper_bound`.
- **No ambient authority**: there is no global `fetch`, `Date`, `Math.random`, `localStorage`, or `console`. A program that did not receive a capability cannot name it.
- Grants are **attenuable**: a capability passed to a callee can only be narrowed, never widened.
- Every capsule call is recorded in the trace, so replay is exact even with effects.

## 13. Diagnostics

| Code | Phase | Meaning |
|---|---|---|
| `E_UNBOUNDED_LOOP` | verify | No variant function for a loop (O3). |
| `E_RECURSION` | verify | Cycle in the call graph (O4). |
| `E_INDEX_OOB` | verify | An index range is not contained in the array length (O2). |
| `E_TYPE_MISMATCH` | typecheck | Operand or cast types disagree (§5). |
| `E_MISSING_RETURN` | typecheck | A path can fall off a non-`unit` function (§5.3). |
| `E_SCOPE` | resolve | Name used outside the block where it was bound. |
| `E_DIV_BY_ZERO` | verify | Divisor is provably zero. |
| `E_ARITY` | typecheck | Call argument count differs from the declaration. |
| `E_ARRAY_SIZE` | typecheck | Repeat-literal length ≠ annotated length. |
| `E_INDEX_TYPE` | typecheck | Index is not `i32`/`i64`. |
| `E_PARSE` | parse | The token stream does not match §4. |
| `E_MEMORY` | parse/verify | An array or total allocation exceeds the arena (O5). |
| `E_GAS_UNBOUNDED` | verify | No finite gas bound could be computed (O6). |
| `E_UNSUPPORTED` | any | A construct this version deliberately does not implement. |

`E_MEMORY` is raised at parse time for a single array larger than 4095 elements, because
array length is part of the type and a longer one cannot be expressed by the handle encoding (§6).

## 14. Conformance

`corpus/examples.json` is the v0.1 conformance suite: 10 programs that must compile and run, 10 that must be rejected with the exact code shown. Each valid entry carries `args` and an `expected` result, so "runs" means *produces this value*, not *compiles*.

`corpus/attacks.json` is the adversarial half (§11.2): 50 programs whose expected outcome is either a named refusal or containment under the proven bound. It has the same standing as the conformance suite — an attack may not be weakened or removed because it now passes for the wrong reason.

Both are owned by this document, not by the implementation — adding a feature without a corpus entry is not allowed, and no corpus entry may be weakened to make an implementation pass.

## 15. Open questions for v0.2

1. ~~Bytecode ISA: stack vs register.~~ **Resolved:** stack, because dispatch cost dominates
   at this scale and the register variant buys nothing measurable yet (S2 numbers).
2. Loop-bound inference: the shipped verifier handles single-counter loops with constant or
   parameter limits. The remaining work is multi-variable variants, decrease through function
   calls, and obligations discharged by SMT (Z3) instead of by construction.
3. `#[bounded(max = K)]` annotations: should a model be allowed to *assert* a bound and have
   the verifier check it? (Cheap for the model, still sound for us — likely yes.)
4. Capsule ABI shape: static import table vs passed capability values.
5. Second implementation of the VM (Rust) to compare traces across engines — the strongest
   form of the S4 determinism claim, and the baseline for S8 performance work.
