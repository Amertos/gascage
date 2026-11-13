import { useMemo, useState } from 'react';
import claimsDoc from '../bench/claims.json';
import corpusDoc from '../corpus/examples.json';
import { verifyAndRunExample, type VerifiedRun } from './core';

type Claim = {
  id: string;
  text: string;
  milestone: string;
  value: number | null;
  unit: string;
  status: 'not_measured' | 'measured' | 'withdrawn';
  reproduce: string | null;
};

type Example = {
  id: string;
  expect: 'valid' | 'invalid';
  code_expected: string | null;
  why: string;
  args?: unknown[];
  expected?: number;
  code: string;
};

const claims = (claimsDoc as { claims: Claim[] }).claims;
const examples = (corpusDoc as { examples: Example[] }).examples;
const runnable = examples.filter((e) => e.expect === 'valid');

const PIPELINE = [
  'natural language',
  'LLM + grammar',
  'AST',
  'typed HIR',
  'VERIFIER',
  'bytecode',
  'WASM VM',
  'trace',
];

function StatusDot({ status }: { status: Claim['status'] }) {
  const color =
    status === 'measured' ? 'var(--ok)' : status === 'withdrawn' ? 'var(--bad)' : 'var(--muted)';
  return <span className="dot" style={{ background: color }} aria-hidden="true" />;
}

function VerdictPanel({ result }: { result: VerifiedRun }) {
  if (!result.ok) {
    return (
      <div className="panel rejected">
        <div className="verdict bad">REJECTED</div>
        <p>
          <code>{result.code}</code> {result.message}
        </p>
      </div>
    );
  }

  return (
    <div className="panel accepted">
      <div className="verdict good">ACCEPTED · then executed inside the proven bound</div>
      <dl className="facts">
        <div>
          <dt>gas proven</dt>
          <dd>{result.gasBound}</dd>
        </div>
        <div>
          <dt>gas used</dt>
          <dd>{result.gasUsed}</dd>
        </div>
        <div>
          <dt>slack</dt>
          <dd>{result.slack}</dd>
        </div>
        <div>
          <dt>memory ≤</dt>
          <dd>{result.memoryBytes} B</dd>
        </div>
        <div>
          <dt>value</dt>
          <dd>{result.value}</dd>
        </div>
      </dl>
      <p className="note">
        The run used <code>gasLimit = {result.gasBound}</code> — the proven bound was the entire
        budget. If the proof were wrong, this program would have died with <code>OutOfGas</code>.
      </p>
    </div>
  );
}

export function App() {
  const measured = claims.filter((c) => c.status === 'measured').length;
  const [index, setIndex] = useState(() => runnable.findIndex((e) => e.id === 'slalom_katamaran'));
  const selected = runnable[Math.max(0, index)] ?? runnable[0]!;

  const result = useMemo(
    () => verifyAndRunExample(selected.code, selected.id, selected.args ?? []),
    [selected],
  );

  return (
    <main>
      <header>
        <h1>gascage</h1>
        <p className="tagline">
          Runtime for code written by an unreliable model: <strong>the gas bound is proven before
          execution</strong>, the sandbox has no ambient authority, and execution is deterministic
          enough to replay bit-for-bit.
        </p>
        <p className="meta">
          {measured}/{claims.length} claims measured · spec v0.1 · verifier v0.1
        </p>
      </header>

      <section>
        <h2>Pipeline</h2>
        <ol className="pipeline">
          {PIPELINE.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section>
        <h2>Verify &amp; run a real program</h2>
        <div className="picker">
          <select
            value={selected.id}
            onChange={(e) => setIndex(runnable.findIndex((x) => x.id === e.target.value))}
            aria-label="corpus program"
          >
            {runnable.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
              </option>
            ))}
          </select>
          <span className="meta">
            {selected.args?.length ?? 0} argument(s)
            {selected.expected !== undefined ? ` · expected ${String(selected.expected)}` : ''}
          </span>
        </div>

        <pre>{selected.code}</pre>
        <p className="note">{selected.why}</p>

        <VerdictPanel result={result} />

        <p className="note">
          The other 10 corpus programs are rejected before execution, each with its documented code
          (<code>E_UNBOUNDED_LOOP</code>, <code>E_RECURSION</code>, <code>E_INDEX_OOB</code>, …).
        </p>
      </section>

      <section>
        <h2>Claims</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Claim</th>
              <th>Milestone</th>
              <th>Value</th>
              <th>Reproduce</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((c, i) => (
              <tr key={c.id}>
                <td className="num">{i + 1}</td>
                <td>
                  <StatusDot status={c.status} /> {c.text}
                </td>
                <td className="num">{c.milestone}</td>
                <td className="num">{c.value === null ? '—' : `${c.value} ${c.unit}`}</td>
                <td>{c.reproduce ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          A claim gets a number only when CI reproduces it. Anything marked{' '}
          <em>not measured</em> is a promise, not a result.
        </p>
      </section>

      <footer>
        <p>
          Docs: <code>docs/spec-v0.1.md</code> · <code>docs/spec-v0.2-isa.md</code> ·{' '}
          <code>docs/PLAN.md</code>
        </p>
      </footer>
    </main>
  );
}
