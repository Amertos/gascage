/**
 * Diagnostics. One code per failure class, fixed by the spec, so the conformance
 * corpus can assert the exact reason a program is rejected.
 */
export const DIAGNOSTIC_CODES = [
  'E_PARSE',
  'E_SCOPE',
  'E_TYPE_MISMATCH',
  'E_ARITY',
  'E_INDEX_TYPE',
  'E_INDEX_OOB',
  'E_ARRAY_SIZE',
  'E_DIV_BY_ZERO',
  'E_MISSING_RETURN',
  'E_RECURSION',
  'E_UNBOUNDED_LOOP',
  'E_MEMORY',
  'E_GAS_UNBOUNDED',
  'E_UNSUPPORTED',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export class GsError extends Error {
  readonly code: DiagnosticCode;
  readonly pos: number;

  constructor(code: DiagnosticCode, message: string, pos = 0) {
    super(message);
    this.name = 'GsError';
    this.code = code;
    this.pos = pos;
  }
}
