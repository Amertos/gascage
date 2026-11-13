/** Parser for `gs` (spec v0.1 §4). Recursive descent, explicit precedence. */
import { GsError } from './diagnostics';
import type { BinOp, Expr, FnDecl, Module, Param, Stmt, Type } from './ast';
import { typeName } from './ast';
import { lex, type Token } from './lexer';

/** Precedence, tightest last: || < && < equality < relational < as < additive < multiplicative. */
const BINARY_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

const AS_PREC = 5;

class Parser {
  private readonly toks: Token[];
  private i = 0;

  constructor(src: string) {
    this.toks = lex(src);
  }

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.i++;
    return t;
  }

  private atOp(text: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.text === text;
  }

  private atKeyword(text: string): boolean {
    const t = this.peek();
    return t.kind === 'keyword' && t.text === text;
  }

  private expectOp(text: string): Token {
    const t = this.peek();
    if (t.kind !== 'op' || t.text !== text) {
      throw new GsError('E_PARSE', `expected "${text}" but found "${t.text}"`, t.pos);
    }
    return this.next();
  }

  private expectKeyword(text: string): Token {
    const t = this.peek();
    if (t.kind !== 'keyword' || t.text !== text) {
      throw new GsError('E_PARSE', `expected "${text}" but found "${t.text}"`, t.pos);
    }
    return this.next();
  }

  private expectIdent(): Token {
    const t = this.peek();
    if (t.kind !== 'ident') {
      throw new GsError('E_PARSE', `expected an identifier but found "${t.text}"`, t.pos);
    }
    return this.next();
  }

  private expectNum(): Token {
    const t = this.peek();
    if (t.kind !== 'num' || t.isFloat) {
      throw new GsError('E_PARSE', `expected an integer but found "${t.text}"`, t.pos);
    }
    return this.next();
  }

  // ---- types -------------------------------------------------------------

  parseType(): Type {
    const t = this.peek();
    if (t.kind === 'keyword') {
      if (t.text === 'i32' || t.text === 'i64' || t.text === 'f64' || t.text === 'bool' || t.text === 'unit') {
        this.next();
        return { kind: t.text };
      }
    }
    if (t.kind === 'op' && t.text === '[') {
      this.next();
      const elem = this.parseType();
      this.expectOp(';');
      const len = this.expectNum();
      this.expectOp(']');
      const n = len.value ?? -1;
      if (!Number.isInteger(n) || n < 1) {
        throw new GsError('E_PARSE', `invalid array length ${len.text}`, len.pos);
      }
      if (n > 4095) {
        throw new GsError('E_MEMORY', `array length ${n} exceeds the 4095-element limit`, len.pos);
      }
      return { kind: 'array', elem, len: n };
    }
    throw new GsError('E_PARSE', `expected a type but found "${t.text}"`, t.pos);
  }

  // ---- program -----------------------------------------------------------

  parseModule(): Module {
    const fns: FnDecl[] = [];
    while (this.peek().kind !== 'eof') {
      fns.push(this.parseFn());
    }
    return { fns };
  }

  private parseFn(): FnDecl {
    const kw = this.expectKeyword('fn');
    const name = this.expectIdent();
    this.expectOp('(');
    const params: Param[] = [];
    if (!this.atOp(')')) {
      for (;;) {
        const pname = this.expectIdent();
        this.expectOp(':');
        params.push({ name: pname.text, type: this.parseType(), pos: pname.pos });
        if (this.atOp(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    this.expectOp('->');
    const ret = this.parseType();
    const body = this.parseBlock();
    return { name: name.text, params, ret, body, pos: kw.pos };
  }

  private parseBlock(): Stmt[] {
    this.expectOp('{');
    const stmts: Stmt[] = [];
    while (!this.atOp('}')) {
      if (this.peek().kind === 'eof') {
        throw new GsError('E_PARSE', 'unterminated block', this.peek().pos);
      }
      stmts.push(this.parseStmt());
    }
    this.expectOp('}');
    return stmts;
  }

  private parseStmt(): Stmt {
    const t = this.peek();

    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'let': {
          this.next();
          const name = this.expectIdent();
          this.expectOp(':');
          const type = this.parseType();
          this.expectOp('=');
          const init = this.parseExpr();
          this.expectOp(';');
          return { kind: 'let', name: name.text, type, init, pos: t.pos };
        }
        case 'if': {
          this.next();
          const cond = this.parseExpr();
          const then = this.parseBlock();
          let els: Stmt[] | null = null;
          if (this.atKeyword('else')) {
            this.next();
            els = this.parseBlock();
          }
          return { kind: 'if', cond, then, els, pos: t.pos };
        }
        case 'while': {
          this.next();
          const cond = this.parseExpr();
          const body = this.parseBlock();
          return { kind: 'while', cond, body, pos: t.pos };
        }
        case 'return': {
          this.next();
          let value: Expr | null = null;
          if (!this.atOp(';')) value = this.parseExpr();
          this.expectOp(';');
          return { kind: 'return', value, pos: t.pos };
        }
        default:
          break;
      }
    }

    // `set x = e;` vs the expression statement `x;` — disambiguated by the `=`
    // that follows the identifier ( `==` is a single token, so no clash).
    if (t.kind === 'ident' && this.peek(1).kind === 'op' && this.peek(1).text === '=') {
      this.next();
      this.next();
      const value = this.parseExpr();
      this.expectOp(';');
      return { kind: 'set', name: t.text, value, pos: t.pos };
    }

    const expr = this.parseExpr();
    this.expectOp(';');
    return { kind: 'expr', expr, pos: t.pos };
  }

  // ---- expressions -------------------------------------------------------

  parseExpr(): Expr {
    return this.parseBinary(1);
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();

    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && t.text === '(') {
        // Calls are only valid on a bare name; anything else is a parse error.
        throw new GsError('E_PARSE', 'only named functions can be called', t.pos);
      }
      if (t.kind === 'op' && t.text === '[') {
        this.next();
        const index = this.parseExpr();
        this.expectOp(']');
        left = { kind: 'index', target: left, index, pos: t.pos };
        continue;
      }
      if (t.kind === 'keyword' && t.text === 'as') {
        if (AS_PREC < minPrec) break;
        this.next();
        const to = this.parseType();
        left = { kind: 'cast', expr: left, to, pos: t.pos };
        continue;
      }
      if (t.kind !== 'op') break;
      const prec = BINARY_PREC[t.text];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { kind: 'bin', op: t.text as BinOp, left, right, pos: t.pos };
    }

    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '!')) {
      this.next();
      return { kind: 'un', op: t.text, expr: this.parseUnary(), pos: t.pos };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === 'num') {
      this.next();
      return { kind: 'num', value: t.value ?? 0, isFloat: t.isFloat === true, pos: t.pos };
    }

    if (t.kind === 'keyword' && (t.text === 'true' || t.text === 'false')) {
      this.next();
      return { kind: 'bool', value: t.text === 'true', pos: t.pos };
    }

    if (t.kind === 'ident') {
      this.next();
      if (this.atOp('(')) {
        this.next();
        const args: Expr[] = [];
        if (!this.atOp(')')) {
          for (;;) {
            args.push(this.parseExpr());
            if (this.atOp(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(')');
        return { kind: 'call', name: t.text, args, pos: t.pos };
      }
      return { kind: 'var', name: t.text, pos: t.pos };
    }

    if (t.kind === 'op' && t.text === '(') {
      this.next();
      const inner = this.parseExpr();
      this.expectOp(')');
      return inner;
    }

    if (t.kind === 'op' && t.text === '[') {
      this.next();
      const first = this.parseExpr();
      if (this.atOp(';')) {
        this.next();
        const len = this.expectNum();
        this.expectOp(']');
        const n = len.value ?? 0;
        if (!Number.isInteger(n) || n < 1) {
          throw new GsError('E_PARSE', `invalid array length ${len.text}`, len.pos);
        }
        return { kind: 'arrayRepeat', value: first, len: n, pos: t.pos };
      }
      const elems: Expr[] = [first];
      while (this.atOp(',')) {
        this.next();
        elems.push(this.parseExpr());
      }
      this.expectOp(']');
      return { kind: 'arrayLit', elems, pos: t.pos };
    }

    throw new GsError('E_PARSE', `unexpected token "${t.text}"`, t.pos);
  }
}

export function parse(src: string): Module {
  const mod = new Parser(src).parseModule();
  if (mod.fns.length === 0) throw new GsError('E_PARSE', 'module has no functions');
  return mod;
}

/** Re-exported for diagnostics: renders a type the way the source spells it. */
export { typeName };
