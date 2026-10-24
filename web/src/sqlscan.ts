// A small SQL scanner mirroring the backend lexer: enough to decide whether
// Enter should run the buffer, to find statement boundaries, and to tokenize
// the current statement for completions.

export type TokKind = 'word' | 'quoted' | 'string' | 'number' | 'punct' | 'op' | 'meta' | 'param';

export interface Token {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
}

export interface Scan {
  tokens: Token[];
  /** Offsets just after each top-level semicolon. */
  boundaries: number[];
  /** Position is inside an unterminated string/comment/quoted identifier. */
  openAt: number | null;
  /** Parenthesis depth at end of input. */
  depth: number;
}

const isIdentStart = (c: string) => /[\p{L}_]/u.test(c);
const isIdent = (c: string) => /[\p{L}\p{N}_$]/u.test(c);

export function scan(text: string): Scan {
  const tokens: Token[] = [];
  const boundaries: number[] = [];
  let depth = 0;
  let begin = 0; // BEGIN ATOMIC depth
  let words: string[] = [];
  let openAt: number | null = null;
  const n = text.length;
  let i = 0;
  const createRoutine = () =>
    (words[0] === 'create' && (words[1] === 'function' || words[1] === 'procedure')) ||
    (words[0] === 'create' && words[1] === 'or' && words[2] === 'replace' && (words[3] === 'function' || words[3] === 'procedure'));
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const e = text.indexOf('\n', i);
      if (e < 0) {
        openAt = i;
        i = n;
      } else i = e;
      continue;
    }
    if (c === '/' && next === '*') {
      let d = 0;
      const s = i;
      while (i < n) {
        if (text[i] === '/' && text[i + 1] === '*') {
          d++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          d--;
          i += 2;
          if (d === 0) break;
        } else i++;
      }
      if (d > 0) openAt = s;
      continue;
    }
    if (c === "'") {
      let s = i;
      // E'...' strings allow backslash escapes; the E was scanned as a word.
      const prev = tokens[tokens.length - 1];
      const esc = !!prev && prev.kind === 'word' && prev.end === i && /^[eE]$/.test(prev.text);
      if (esc) {
        tokens.pop();
        s = prev.start;
      }
      i++;
      let closed = false;
      while (i < n) {
        if (esc && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          break;
        }
        i++;
      }
      i++;
      if (!closed) openAt = s;
      tokens.push({ kind: 'string', text: text.slice(s, i), start: s, end: Math.min(i, n) });
      continue;
    }
    if (c === '"') {
      const s = i;
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          closed = true;
          break;
        }
        i++;
      }
      i++;
      if (!closed) openAt = s;
      tokens.push({ kind: 'quoted', text: text.slice(s, i), start: s, end: Math.min(i, n) });
      continue;
    }
    if (c === '$' && !(i > 0 && isIdent(text[i - 1]))) {
      const m = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = text.indexOf(tag, i + tag.length);
        const s = i;
        if (e < 0) {
          openAt = s;
          i = n;
        } else i = e + tag.length;
        tokens.push({ kind: 'string', text: text.slice(s, i), start: s, end: i });
        continue;
      }
      const p = /^\$\d+/.exec(text.slice(i));
      if (p) {
        tokens.push({ kind: 'param', text: p[0], start: i, end: i + p[0].length });
        i += p[0].length;
        continue;
      }
    }
    if (c === '\\') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      tokens.push({ kind: 'meta', text: text.slice(i, end), start: i, end });
      i = end;
      words = [];
      continue;
    }
    if (isIdentStart(c)) {
      const s = i;
      while (i < n && isIdent(text[i])) i++;
      const w = text.slice(s, i);
      const lw = w.toLowerCase();
      if (words.length < 4) words.push(lw);
      if (lw === 'begin' && createRoutine()) begin++;
      else if (lw === 'case' && begin > 0) begin++;
      else if (lw === 'end' && begin > 0) begin--;
      tokens.push({ kind: 'word', text: w, start: s, end: i });
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(next ?? ''))) {
      const m = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(text.slice(i))!;
      tokens.push({ kind: 'number', text: m[0], start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && depth > 0) depth--;
    if (c === ';' && depth === 0 && begin === 0) {
      boundaries.push(i + 1);
      words = [];
    }
    if (c === ':' && next === ':') {
      tokens.push({ kind: 'op', text: '::', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ kind: /[(),;.[\]]/.test(c) ? 'punct' : 'op', text: c, start: i, end: i + 1 });
    i++;
  }
  return { tokens, boundaries, openAt, depth };
}

/** Should pressing Enter at the end of `text` execute it (psql semantics)? */
export function isComplete(text: string): boolean {
  if (!text.trim()) return false;
  const s = scan(text);
  if (s.openAt !== null) return false;
  const last = s.tokens[s.tokens.length - 1];
  if (!last) return false;
  // A backslash command on the last line runs immediately.
  if (last.kind === 'meta') return true;
  return last.kind === 'punct' && last.text === ';' && s.boundaries.length > 0 && s.boundaries[s.boundaries.length - 1] === last.end;
}

/** The [start, end) range of the statement containing `pos`. */
export function statementRange(text: string, pos: number): [number, number] {
  const s = scan(text);
  let start = 0;
  let end = text.length;
  for (const b of s.boundaries) {
    if (b <= pos) start = b;
    else {
      end = b;
      break;
    }
  }
  // Meta commands also delimit statements.
  for (const t of s.tokens) {
    if (t.kind !== 'meta') continue;
    if (t.start < pos && pos <= t.end) return [t.start, t.end];
    if (t.end < pos && t.end > start) start = t.end;
    if (t.start >= pos && t.start < end) end = t.start;
  }
  return [start, end];
}

/** Normalize an identifier token as PostgreSQL would. */
export function identName(t: Token): string {
  if (t.kind === 'quoted') return t.text.slice(1, t.text.endsWith('"') && t.text.length > 1 ? -1 : undefined).replace(/""/g, '"');
  return t.text.toLowerCase();
}

/** Quote an identifier if it would not round-trip unquoted. */
export function quoteIdent(name: string, keywords?: Set<string>): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !keywords?.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}
