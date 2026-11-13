/** Source → bytecode, with every rejection reported as a spec diagnostic code. */
import type { Type } from './ast';
import { checkModule, type FnInfo } from './check';
import { GsError, type DiagnosticCode } from './diagnostics';
import { lower } from './lower';
import { parse } from './parser';
import type { AsmProg } from './program';

export interface FnSummary {
  name: string;
  index: number;
  params: Type[];
  ret: Type;
}

export type CompileResult =
  | { ok: true; program: AsmProg; fns: FnSummary[]; main: number }
  | { ok: false; code: DiagnosticCode; message: string; pos: number };

export interface CompileOptions {
  /** Entry function name. Defaults to "main" if present, else the first function. */
  main?: string;
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  try {
    const mod = parse(source);
    const infos: FnInfo[] = checkModule(mod);

    let mainIndex = 0;
    if (options.main !== undefined) {
      const found = infos.find((f) => f.name === options.main);
      if (found === undefined) {
        return {
          ok: false,
          code: 'E_SCOPE',
          message: `entry function "${options.main}" was not found`,
          pos: 0,
        };
      }
      mainIndex = found.index;
    } else {
      const main = infos.find((f) => f.name === 'main');
      mainIndex = main?.index ?? 0;
    }

    const { builder } = lower(infos);
    const program = builder.assemble({ main: mainIndex });

    return {
      ok: true,
      program,
      main: mainIndex,
      fns: infos.map((f) => ({ name: f.name, index: f.index, params: f.params, ret: f.ret })),
    };
  } catch (err) {
    if (err instanceof GsError) {
      return { ok: false, code: err.code, message: err.message, pos: err.pos };
    }
    throw err;
  }
}
