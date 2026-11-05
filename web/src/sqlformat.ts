// Format SQL on request (Format SQL in the Editor menu, Ctrl/⌘+Shift+F).
//
// The layout comes from sql-formatter's PostgreSQL dialect. There's no one
// accepted SQL style, so the layout and keyword case are preferences. Two
// things are ours: psql backslash commands are kept as they are (only the SQL
// between them is formatted), and the result must have the same tokens as the
// input — only whitespace and the case of unquoted words may change — or it
// is rejected, so formatting can never change what a query does.

import { formatDialect, postgresql } from 'sql-formatter';
import type { FormatCase, FormatLayout } from './prefs';
import { scan, type Token } from './sqlscan';

export interface FormatStyle {
  layout: FormatLayout;
  keywordCase: FormatCase;
}

export type FormatResult = { text: string } | { error: string };

const indentStyle = { indented: 'standard', 'aligned-left': 'tabularLeft', 'aligned-right': 'tabularRight' } as const;

function formatChunk(sql: string, style: FormatStyle): string {
  if (!sql.trim()) return '';
  return formatDialect(sql, {
    dialect: postgresql,
    indentStyle: indentStyle[style.layout],
    keywordCase: style.keywordCase,
    dataTypeCase: style.keywordCase,
    tabWidth: 2,
  })
    .replace(/^\s*\n/, '')
    .trimEnd();
}

export function formatSql(text: string, style: FormatStyle): FormatResult {
  let out = '';
  try {
    let pos = 0;
    for (const m of scan(text).tokens.filter((t) => t.kind === 'meta')) {
      const before = text.slice(pos, m.start);
      const sql = formatChunk(before, style);
      // A backslash command on the same line as the query it ends (`select 1 \gx`) stays on that line.
      const sameLine = sql && !/\n\s*$/.test(before);
      out = join(join(out, sql, '\n'), m.text.trim(), sameLine ? ' ' : '\n');
      pos = m.end;
    }
    out = join(out, formatChunk(text.slice(pos), style), '\n');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg.split('\n')[0] };
  }
  if (!sameTokens(text, out)) return { error: 'the formatter would have changed the query' };
  return { text: out };
}

function join(a: string, b: string, sep: string): string {
  return a && b ? a + sep + b : a || b;
}

/** Tokens compared up to whitespace and the case of unquoted words. */
function signature(text: string): string[] {
  const sig: string[] = [];
  let prev: Token | undefined;
  for (const t of scan(text, { comments: true }).tokens) {
    // Operator characters that touch form one operator (`<=`, `->>`); a space between them would change it.
    if (t.kind === 'op' && prev?.kind === 'op' && prev.end === t.start) sig[sig.length - 1] += t.text;
    else if (t.kind === 'word') sig.push(`word ${t.text.toLowerCase()}`);
    else if (t.kind === 'comment' || t.kind === 'meta') sig.push(`${t.kind} ${t.text.replace(/\s+/g, ' ').trim()}`);
    else sig.push(`${t.kind} ${t.text}`);
    prev = t;
  }
  return sig;
}

export function sameTokens(a: string, b: string): boolean {
  const x = signature(a);
  const y = signature(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** Where `pos` in `from` ends up in `to`, counting non-whitespace characters, so the cursor stays on the same token. */
export function mapPosition(from: string, to: string, pos: number): number {
  let n = 0;
  for (let i = 0; i < pos && i < from.length; i++) if (!/\s/.test(from[i])) n++;
  if (n === 0) return 0;
  for (let i = 0; i < to.length; i++) {
    if (!/\s/.test(to[i]) && --n === 0) return i + 1;
  }
  return to.length;
}
