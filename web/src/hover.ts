// Hover tooltips for names in the editor: tables (columns, keys, comment),
// columns (type, constraints, foreign key), aliases, CTEs, derived tables and
// functions, resolved through the statement's scopes.

import { hoverTooltip } from '@codemirror/view';
import type { Catalog } from './catalog';
import { sourceView } from './completion';
import { columnView, functionView, relationView } from './schemaview';
import { analyze, type Column, findSource, resolveColumn, type Scope, scopeAt, type Source, sourceColumns } from './scope';
import { identName, scan, statementRange, type Token } from './sqlscan';
import type { Meta, Relation } from './types';

export type HoverTarget =
  | { kind: 'relation'; rel: Relation; alias?: string }
  | { kind: 'source'; src: Source }
  | { kind: 'column'; col: Column; owner?: Source }
  | { kind: 'function'; fns: Meta['functions'] };

const isName = (t?: Token) => !!t && (t.kind === 'word' || t.kind === 'quoted');

function allScopes(s: Scope, out: Scope[] = []): Scope[] {
  out.push(s);
  for (const c of s.children) allScopes(c, out);
  return out;
}

/** What the name at `pos` refers to, and the document range it covers. */
export function hoverTarget(cat: Catalog, doc: string, pos: number, side: -1 | 1 = 1): { target: HoverTarget; from: number; to: number } | null {
  const [stmtStart, stmtEnd] = statementRange(doc, pos);
  const text = doc.slice(stmtStart, stmtEnd);
  const toks = scan(text).tokens;
  const rel = pos - stmtStart;
  const k = toks.findIndex((t) => isName(t) && (t.start < rel || (t.start === rel && side > 0)) && (rel < t.end || (rel === t.end && side < 0)));
  if (k < 0) return null;
  // The dotted chain the token is part of: a.b.c
  let first = k;
  while (toks[first - 1]?.text === '.' && isName(toks[first - 2])) first -= 2;
  let lastIdx = k;
  while (toks[lastIdx + 1]?.text === '.' && isName(toks[lastIdx + 2])) lastIdx += 2;
  const chain: string[] = [];
  for (let i = first; i <= lastIdx; i += 2) chain.push(identName(toks[i]));
  const idx = (k - first) / 2;
  const tok = toks[k];
  const result = (target: HoverTarget | undefined) => (target ? { target, from: stmtStart + tok.start, to: stmtStart + tok.end } : null);

  // A function call.
  if (idx === chain.length - 1 && toks[k + 1]?.text === '(') {
    const fns = cat.functions(chain[idx], idx > 0 ? chain[idx - 1] : undefined);
    if (fns.length) return result({ kind: 'function', fns });
  }

  const root = analyze(toks, text.length);
  const scope = scopeAt(root, tok.start);

  // A FROM item (its name or alias) or a CTE's name where it's defined.
  for (const s of allScopes(root)) {
    for (const c of s.ctes) {
      if (c.start === tok.start) return result({ kind: 'source', src: { kind: 'cte', name: c.name, cte: c, body: c.body, start: c.start, end: c.end, nameStart: c.start, nameEnd: c.end } });
    }
    for (const src of s.sources) {
      if (tok.start < src.start || tok.end > src.end) continue;
      // Inside a derived table's parentheses is that query's business.
      if (src.body && tok.start < src.nameEnd) continue;
      if (src.kind === 'table') {
        const r = cat.resolve(src.name, src.schema);
        // The schema part of schema.table isn't the table.
        if (r && !(src.schema && idx < chain.length - 1 && tok.end <= src.nameEnd)) return result({ kind: 'relation', rel: r, alias: src.alias });
      } else if (src.kind === 'function' && tok.start < src.nameEnd) {
        continue;
      } else return result({ kind: 'source', src });
    }
  }

  const name = chain[idx];
  if (idx === chain.length - 1) {
    // A column, possibly qualified.
    const ref = chain.slice(0, idx + 1);
    const col = resolveColumn(scope, ref, cat);
    if (col) return result({ kind: 'column', col, owner: ref.length >= 2 ? findSource(scope, ref[ref.length - 2]) : ownerOf(scope, name, cat) });
    if (chain.length === 1) {
      const src = findSource(scope, name);
      if (src) return result(sourceTarget(cat, src));
    }
    const r = idx === 1 ? cat.resolve(name, chain[0]) : chain.length === 1 ? cat.resolve(name) : undefined;
    if (r) return result({ kind: 'relation', rel: r });
    return null;
  }
  // A qualifier: alias.col, table.col, schema.table.col
  if (idx === chain.length - 2) {
    const src = findSource(scope, name);
    if (src) return result(sourceTarget(cat, src));
    const r = cat.resolve(name, idx > 0 ? chain[idx - 1] : undefined);
    if (r) return result({ kind: 'relation', rel: r });
  }
  return null;
}

function sourceTarget(cat: Catalog, src: Source): HoverTarget {
  if (src.kind === 'table') {
    const r = cat.resolve(src.name, src.schema);
    if (r) return { kind: 'relation', rel: r, alias: src.alias };
  }
  return { kind: 'source', src };
}

/** The source an unqualified column comes from. */
function ownerOf(scope: Scope, name: string, cat: Catalog): Source | undefined {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const src of s.sources) if (sourceColumns(src, cat).some((c) => c.name === name)) return src;
  }
  return undefined;
}

function render(cat: Catalog, t: HoverTarget): HTMLElement {
  switch (t.kind) {
    case 'relation':
      return relationView(cat, t.rel, t.alias);
    case 'source':
      return sourceView(cat, t.src);
    case 'function':
      return functionView(t.fns);
    case 'column': {
      const owner = t.col.rel ? undefined : t.owner && (t.owner.alias ?? t.owner.name);
      return columnView(cat, t.col, owner || undefined);
    }
  }
}

export function pgHover(getCatalog: () => Catalog | null) {
  return hoverTooltip(
    (view, pos, side) => {
      const cat = getCatalog();
      if (!cat) return null;
      const hit = hoverTarget(cat, view.state.doc.toString(), pos, side);
      if (!hit) return null;
      return { pos: hit.from, end: hit.to, above: true, create: () => ({ dom: render(cat, hit.target) }) };
    },
    { hoverTime: 350 },
  );
}
