# LLM front-end without paying anything

The verifier is the product; the model is a replaceable part. Keep it that way with a one-file adapter interface and never let model choice leak into the core.

## Ranked options

### 1. Local `llama.cpp` / Ollama — default

```bash
ollama pull qwen2.5-coder:7b          # or llama3.2:3b on a weak laptop
ollama serve                          # OpenAI-compatible on :11434
```

Why this is the right default for gascage:

- **Free and offline.** No key, no quota, no rate limit, no data leaves the machine.
- **GBNF grammar-constrained decoding.** You pass a grammar and the model *cannot* emit a token that leaves the language. This is stronger than JSON-schema output: it eliminates syntax errors entirely, so the repair loop only has to deal with type errors and failed obligations.
- **Deterministic-ish generation** at `temperature=0, seed=fixed`, which pairs with the S4 replay story.

Ollama exposes a `format` field for JSON schema and raw `grammar` on `/api/generate`; `llama-server --grammar-file` takes a GBNF file directly.

### 2. In-browser WebGPU model — best demo

A small model running in a Web Worker via WebGPU (e.g. WebLLM). Zero backend, zero cost, works offline after the first download, and it fits the "runtime on the client" thesis. Cost: 1–3 GB download, slow first token, small models only. Good for the demo, not for the S7 benchmark.

### 3. Free-tier OpenAI-compatible endpoint — fallback only

Useful when the laptop cannot run a 7B model. Rules:

- The key lives in a **server-side proxy** (one route, `POST /api/generate`). Never in the browser bundle, never in a mobile binary.
- Ask for JSON-schema output and still run your own parse — schema compliance is not grammar-level compliance.
- Treat the provider as untrusted: it is exactly the "unreliable model" the sandbox exists for.

## Adapter contract (S7)

```ts
// src/llm/provider.ts — the only place a model is named
export interface GenerateRequest {
  prompt: string;
  grammar: string;        // GBNF, compiled from the spec's EBNF
  maxTokens: number;
  seed: number;
  temperature: 0;         // always 0; variety is the enemy of replay
}
export interface GenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}
export interface Provider {
  id: string;             // "ollama:qwen2.5-coder:7b"
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
```

Because `grammar` is a parameter rather than a suggestion, the S7 benchmark measures the pipeline — grammar, types, verifier, repair — and not the model's politeness. Swapping `ollama:qwen2.5-coder:7b` for `webllm:...` must change the numbers in `bench/claims.json`, and nothing else.
