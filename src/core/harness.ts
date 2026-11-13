/**
 * Test/conformance harness. Given a module and a target function, synthesises a
 * tiny `__driver` entry point that calls it with literal arguments, because the
 * VM can only be entered with scalar arguments (array arguments need a handle,
 * and a handle can only be produced by running code).
 */
import type { Type } from './ast';
import { typeName } from './ast';
import { compile, type FnSummary } from './compiler';
import { run } from './vm';
import type { DiagnosticCode } from './diagnostics';
import { instantiate } from './cost';
import { verifySource } from './verify';

export type ExampleResult =
  | { ok: true; value: number; gasUsed: number; blocks: number }
  | { ok: false; code: DiagnosticCode; message: string };

function floatLiteral(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

function literalFor(t: Type, value: unknown): string {
  if (t.kind === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`expected an array for ${typeName(t)}`);
    }
    return `[${value.map((v) => literalFor(t.elem, v)).join(', ')}]`;
  }
  if (t.kind === 'bool') return value === true || value === 1 ? 'true' : 'false';
  if (t.kind === 'f64') return floatLiteral(Number(value));
  if (t.kind === 'unit') throw new Error('unit is not a valid parameter type here');
  return String(Math.trunc(Number(value)));
}

function driverSource(info: FnSummary, args: unknown[]): string {
  const argText = args.map((a, i) => literalFor(info.params[i]!, a)).join(', ');
  if (info.ret.kind === 'unit') {
    return `\nfn __driver() -> unit {\n  ${info.name}(${argText});\n  return;\n}\n`;
  }
  return `\nfn __driver() -> ${typeName(info.ret)} {\n  return ${info.name}(${argText});\n}\n`;
}

export interface RunExampleOptions {
  gasLimit?: number;
}

/**
 * Compile `source`, then compile it again with a driver for `fnName`, run it,
 * and report either the value or the diagnostic that stopped compilation.
 */
export function runExample(
  source: string,
  fnName: string,
  args: unknown[] = [],
  options: RunExampleOptions = {},
): ExampleResult {
  const first = compile(source);
  if (!first.ok) return { ok: false, code: first.code, message: first.message };

  const info = first.fns.find((f) => f.name === fnName);
  if (info === undefined) {
    return { ok: false, code: 'E_SCOPE', message: `no function named "${fnName}"` };
  }
  if (info.params.length !== args.length) {
    return {
      ok: false,
      code: 'E_ARITY',
      message: `${fnName} takes ${info.params.length} argument(s), got ${args.length}`,
    };
  }

  let driver: string;
  try {
    driver = driverSource(info, args);
  } catch (err) {
    return { ok: false, code: 'E_TYPE_MISMATCH', message: (err as Error).message };
  }

  const second = compile(source + driver, { main: '__driver' });
  if (!second.ok) return { ok: false, code: second.code, message: second.message };

  const result = run(second.program, [], { gasLimit: options.gasLimit ?? 1_000_000 });
  if (result.kind === 'trap') {
    return {
      ok: false,
      code: 'E_UNSUPPORTED',
      message: `trapped with ${result.trap} at pc ${result.pc}`,
    };
  }

  return {
    ok: true,
    value: result.value,
    gasUsed: result.gasUsed,
    blocks: result.blocks,
  };
}

export type VerifiedRun =
  | {
      ok: true;
      value: number;
      gasUsed: number;
      gasBound: number;
      memoryBytes: number;
      slack: number;
      certificate: { fn: string; loops: number };
    }
  | { ok: false; code: DiagnosticCode; message: string };

/**
 * The whole thesis in one function: prove a bound, then run the program with that
 * bound as its entire gas budget. Zero slack means the proof was tight enough to
 * be the only thing keeping the program alive.
 */
export function verifyAndRunExample(
  source: string,
  fnName: string,
  args: unknown[] = [],
): VerifiedRun {
  const first = compile(source);
  if (!first.ok) return { ok: false, code: first.code, message: first.message };

  const info = first.fns.find((f) => f.name === fnName);
  if (info === undefined) {
    return { ok: false, code: 'E_SCOPE', message: `no function named "${fnName}"` };
  }

  let driver: string;
  try {
    driver = driverSource(info, info.params.map((_, i) => args[i]));
  } catch (err) {
    return { ok: false, code: 'E_TYPE_MISMATCH', message: (err as Error).message };
  }

  const combined = source + driver;
  const verified = verifySource(combined);
  if (!verified.ok) return { ok: false, code: verified.code, message: verified.detail };

  const cert = verified.certs.find((c) => c.fn === '__driver');
  if (cert === undefined) {
    return { ok: false, code: 'E_SCOPE', message: 'the driver was not verified' };
  }

  const compiled = compile(combined, { main: '__driver' });
  if (!compiled.ok) return { ok: false, code: compiled.code, message: compiled.message };

  const bound = instantiate(cert.gas, new Map());
  const result = run(compiled.program, [], { gasLimit: bound });

  if (result.kind === 'trap') {
    return {
      ok: false,
      code: 'E_GAS_UNBOUNDED',
      message:
        result.trap === 'OutOfGas'
          ? `proven bound ${bound} was exceeded: the verifier undercounted gas`
          : `trapped with ${result.trap} under a verified bound`,
    };
  }

  return {
    ok: true,
    value: result.value,
    gasUsed: result.gasUsed,
    gasBound: bound,
    memoryBytes: instantiate(cert.memoryBytes, new Map()),
    slack: bound - result.gasUsed,
    certificate: { fn: cert.fn, loops: cert.loops.length },
  };
}
