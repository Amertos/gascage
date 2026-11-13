/**
 * Public surface of the gascage core.
 * S2: assembler + VM. S3: lexer, parser, typechecker, lowering, harness.
 */
export * from './diagnostics';
export * from './isa';
export * from './program';
export * from './vm';
export * from './ast';
export * from './lexer';
export * from './parser';
export * from './check';
export * from './lower';
export * from './compiler';
export * from './cost';
export * from './verify';
export * from './trace';
export * from './harness';

import type { DiagnosticCode } from './diagnostics';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  span?: { start: number; end: number };
}

/** Gas is an abstract unit: 1 unit is one dispatch of the cheapest instruction. */
export type Gas = bigint;

/** Result of running the verifier (S5). */
export type Verdict =
  | {
      kind: 'accept';
      certificate: {
        fn: string;
        gasUpperBound: Gas;
        memoryUpperBound: number;
        obligations: string[];
      };
    }
  | { kind: 'reject'; code: DiagnosticCode; detail: string };
