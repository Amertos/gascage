/** Types and AST for the `gs` source language (spec v0.1 §4–§5). */

export type Type =
  | { kind: 'i32' }
  | { kind: 'i64' }
  | { kind: 'f64' }
  | { kind: 'bool' }
  | { kind: 'unit' }
  | { kind: 'array'; elem: Type; len: number };

export const T = {
  i32: { kind: 'i32' },
  i64: { kind: 'i64' },
  f64: { kind: 'f64' },
  bool: { kind: 'bool' },
  unit: { kind: 'unit' },
} as const;

export function typeEq(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'array' && b.kind === 'array') {
    return a.len === b.len && typeEq(a.elem, b.elem);
  }
  return true;
}

export function typeName(t: Type): string {
  return t.kind === 'array' ? `[${typeName(t.elem)}; ${t.len}]` : t.kind;
}

export function isNumeric(t: Type): boolean {
  return t.kind === 'i32' || t.kind === 'i64' || t.kind === 'f64';
}

export function isIntegerType(t: Type): boolean {
  return t.kind === 'i32' || t.kind === 'i64';
}

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||';

interface ExprBase {
  pos: number;
  /** Filled in by the typechecker; lowering reads it and never re-infers. */
  type?: Type;
}

export type Expr =
  | (ExprBase & { kind: 'num'; value: number; isFloat: boolean })
  | (ExprBase & { kind: 'bool'; value: boolean })
  | (ExprBase & { kind: 'var'; name: string })
  | (ExprBase & { kind: 'bin'; op: BinOp; left: Expr; right: Expr })
  | (ExprBase & { kind: 'un'; op: '-' | '!'; expr: Expr })
  | (ExprBase & { kind: 'call'; name: string; args: Expr[] })
  | (ExprBase & { kind: 'index'; target: Expr; index: Expr })
  | (ExprBase & { kind: 'cast'; expr: Expr; to: Type })
  | (ExprBase & { kind: 'arrayLit'; elems: Expr[] })
  | (ExprBase & { kind: 'arrayRepeat'; value: Expr; len: number });

export type Stmt =
  | { kind: 'let'; name: string; type: Type; init: Expr; pos: number }
  | { kind: 'set'; name: string; value: Expr; pos: number }
  | { kind: 'if'; cond: Expr; then: Stmt[]; els: Stmt[] | null; pos: number }
  | { kind: 'while'; cond: Expr; body: Stmt[]; pos: number }
  | { kind: 'return'; value: Expr | null; pos: number }
  | { kind: 'expr'; expr: Expr; pos: number };

export interface Param {
  name: string;
  type: Type;
  pos: number;
}

export interface FnDecl {
  name: string;
  params: Param[];
  ret: Type;
  body: Stmt[];
  pos: number;
}

export interface Module {
  fns: FnDecl[];
}
