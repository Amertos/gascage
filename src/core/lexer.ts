/** Lexer for `gs` (spec v0.1 §3). Comments are line-only on purpose. */
import { GsError } from './diagnostics';

export type TokKind = 'ident' | 'keyword' | 'num' | 'op' | 'eof';

export interface Token {
  kind: TokKind;
  text: string;
  pos: number;
  value?: number;
  isFloat?: boolean;
}

const KEYWORDS = new Set([
  'fn', 'let', 'set', 'if', 'else', 'while', 'return', 'as',
  'true', 'false', 'i32', 'i64', 'f64', 'bool', 'unit',
]);

/** Longest first, so `->` never lexes as `-` then `>`. */
const OPS = ['->', '<=', '>=', '==', '!=', '&&', '||',
  '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '{', '}', '[', ']', ';', ',', ':', '!'];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    const start = i;

    if (isDigit(c)) {
      while (i < src.length && (isDigit(src[i]!) || src[i] === '_')) i++;
      let isFloat = false;
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        isFloat = true;
        i++;
        while (i < src.length && isDigit(src[i]!)) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (isDigit(src[i] ?? '')) {
          isFloat = true;
          while (i < src.length && isDigit(src[i]!)) i++;
        } else {
          i = save;
        }
      }
      const raw = src.slice(start, i).replace(/_/g, '');

      // Optional integer width suffix: `10i32`. Context normally decides the
      // type, but the spec allows the suffix and it must not split the token.
      if (!isFloat) {
        if (src.startsWith('i32', i)) i += 3;
        else if (src.startsWith('i64', i)) i += 3;
      }

      toks.push({ kind: 'num', text: raw, pos: start, value: Number(raw), isFloat });
      continue;
    }

    if (isIdentStart(c)) {
      while (i < src.length && isIdentPart(src[i]!)) i++;
      const text = src.slice(start, i);
      toks.push({ kind: KEYWORDS.has(text) ? 'keyword' : 'ident', text, pos: start });
      continue;
    }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (op === undefined) {
      throw new GsError('E_PARSE', `unexpected character ${JSON.stringify(c)}`, i);
    }
    toks.push({ kind: 'op', text: op, pos: start });
    i += op.length;
  }

  toks.push({ kind: 'eof', text: '<eof>', pos: src.length });
  return toks;
}
