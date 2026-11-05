// Context-aware completions in the spirit of pgcli: tables after FROM/JOIN,
// columns of the tables (and aliases) in scope, schema-qualified names,
// types after ::, joins along foreign keys, and backslash commands with
// their arguments.

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { Catalog, type ForeignKeyRef } from './catalog';
import { columnView, derivedView, functionView, noteLine, qualifiedName, relationView } from './schemaview';
import {
  analyze, type Column, findSource, isReserved, refName, type Scope, scopeAt, type Source, sourceColumns, visibleCtes,
  visibleSources,
} from './scope';
import { quoteIdent, scan, statementRange, type Token } from './sqlscan';
import type { Relation } from './types';

export { Catalog };

export const META_COMMANDS: [string, string][] = [
  ['\\?', 'help on backslash commands'],
  ['\\c', 'connect to a database'],
  ['\\conninfo', 'connection information'],
  ['\\copy', 'client-side COPY to/from a file'],
  ['\\d', 'describe table, view, sequence, index'],
  ['\\d+', 'describe with details'],
  ['\\da', 'list aggregates'],
  ['\\dA', 'list access methods'],
  ['\\db', 'list tablespaces'],
  ['\\dconfig', 'list configuration parameters'],
  ['\\dD', 'list domains'],
  ['\\des', 'list foreign servers'],
  ['\\dE', 'list foreign tables'],
  ['\\df', 'list functions'],
  ['\\dg', 'list roles'],
  ['\\di', 'list indexes'],
  ['\\dm', 'list materialized views'],
  ['\\dn', 'list schemas'],
  ['\\dp', 'list access privileges'],
  ['\\ds', 'list sequences'],
  ['\\dt', 'list tables'],
  ['\\dT', 'list data types'],
  ['\\du', 'list roles'],
  ['\\dv', 'list views'],
  ['\\dx', 'list extensions'],
  ['\\dy', 'list event triggers'],
  ['\\echo', 'print text'],
  ['\\g', 'execute query'],
  ['\\gdesc', 'describe result of query'],
  ['\\gx', 'execute query, expanded output'],
  ['\\h', 'SQL command help'],
  ['\\i', 'execute commands from file'],
  ['\\l', 'list databases'],
  ['\\sf', 'show function definition'],
  ['\\sv', 'show view definition'],
  ['\\x', 'toggle expanded output'],
  ['\\z', 'list access privileges'],
];

const RELATION_KW = new Set(['from', 'join', 'update', 'into', 'table', 'truncate', 'only', 'lateral']);
const COLUMN_KW = new Set([
  'select', 'where', 'and', 'or', 'on', 'by', 'set', 'having', 'distinct', 'when', 'then', 'else', 'not',
  'returning', 'using', 'case', 'between', 'in', 'like', 'ilike', 'is', 'as',
]);
const STARTERS = [
  'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'CREATE', 'ALTER', 'DROP', 'EXPLAIN', 'EXPLAIN ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SHOW', 'SET', 'TRUNCATE', 'GRANT', 'REVOKE', 'VACUUM', 'ANALYZE', 'COPY', 'TABLE',
  'VALUES', 'CALL', 'DO', 'LISTEN', 'NOTIFY', 'COMMENT ON', 'REFRESH MATERIALIZED VIEW', 'REINDEX', 'RESET', 'CLUSTER',
];

function caseLike(word: string, typed: string): string {
  return typed && typed === typed.toLowerCase() && /[a-z]/.test(typed) ? word.toLowerCase() : word.toUpperCase();
}

/** Write a keyword in the case of one the user typed (JOIN → ON, join → on). */
function caseOf(sample: Token | undefined, kw: string): string {
  return sample && /[A-Z]/.test(sample.text) && sample.text === sample.text.toUpperCase() ? kw.toUpperCase() : kw.toLowerCase();
}

export function pgCompletion(getCatalog: () => Catalog | null): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const doc = ctx.state.doc.toString();
    const pos = ctx.pos;
    const [stmtStart, stmtEnd] = statementRange(doc, pos);
    const before = doc.slice(stmtStart, pos);
    const sc = scan(before);
    if (sc.openAt !== null && !/^\s*\\/.test(before)) {
      // Inside a string or comment, but allow completing an open quoted identifier.
      const t = sc.tokens[sc.tokens.length - 1];
      if (!t || t.kind !== 'quoted') return null;
    }
    const cat = getCatalog();

    // Backslash commands.
    const metaLine = /(^|\n)[ \t]*(\\[^\s]*)([ \t]+.*)?$/.exec(before);
    if (metaLine) {
      const cmd = metaLine[2];
      if (metaLine[3] === undefined) {
        return {
          from: pos - cmd.length,
          options: META_COMMANDS.map(([label, detail]) => ({ label, detail, type: 'keyword' })),
          validFor: /^\\[\w+?]*$/,
        };
      }
      if (!cat) return null;
      const word = /[\w$."]*$/.exec(before)![0];
      const from = pos - word.length;
      const base = cmd.replace(/[S+]+$/, '');
      if (base === '\\c' || base === '\\connect' || base === '\\l') {
        return { from, options: cat.meta.databases.map((d) => ({ label: d, type: 'namespace' })) };
      }
      if (base === '\\sf' || base.startsWith('\\df')) {
        return { from, options: functionOptions(cat, 0) };
      }
      if (base === '\\dn') return { from, options: cat.meta.schemas.map((s) => ({ label: s, type: 'namespace' })) };
      if (base === '\\du' || base === '\\dg') return { from, options: cat.meta.roles.map((s) => ({ label: s, type: 'variable' })) };
      if (base.startsWith('\\d') || base === '\\sv' || base === '\\z') {
        return { from, options: relationOptions(cat, 0) };
      }
      return null;
    }

    const wordMatch = /(?:(?:"(?:[^"]|"")*"|[\p{L}\p{N}_$]+)\.)*(?:"(?:[^"]|"")*"?|[\p{L}\p{N}_$]*)$/u.exec(before);
    const word = wordMatch ? wordMatch[0] : '';
    const parts = splitQualified(word);
    const last = parts[parts.length - 1];
    const from = pos - last.length;
    // Offsets from here on are relative to the statement.
    const cursor = pos - stmtStart;
    const wordStart = cursor - word.length;
    const tokensBefore = sc.tokens.filter((t) => t.end <= wordStart);
    const prev = tokensBefore[tokensBefore.length - 1];
    const prevKw = prev?.kind === 'word' ? prev.text.toLowerCase() : prev?.text;
    if (!word && !ctx.explicit) return null;
    if (prev?.kind === 'number' && word === '') return null;

    if (!cat) {
      return prev ? null : { from, options: STARTERS.map((s) => ({ label: caseLike(s, last), type: 'keyword' })) };
    }

    const stmtText = doc.slice(stmtStart, stmtEnd);
    const root = analyze(scan(stmtText).tokens, stmtText.length);
    const scope = scopeAt(root, wordStart);
    // The FROM item being typed isn't a source for its own completion.
    const visible = visibleSources(scope).filter(({ src }) => src.kind === 'subquery' || src.kind === 'values' || !(src.start <= cursor && cursor <= src.end));

    // SELECT * or t.* → the column list (Tab or Ctrl+Space right after the star).
    if (prev?.text === '*' && word === '') {
      const item = scope.items.find((it) => it.star && it.end === prev.end);
      const text = item && expandStar(cat, scope, item.star!);
      return text ? { from: stmtStart + item.start, options: [{ label: text, type: 'text', detail: 'expand *' }], filter: false } : null;
    }

    // Qualified: alias.col, table.col, schema.table
    if (parts.length > 1) {
      const qual = parts.slice(0, -1).map(unquote);
      const options: Completion[] = [];
      if (qual.length === 1) {
        const q = qual[0];
        const src = findSource(scope, q);
        const rel = src ? undefined : cat.resolve(q);
        if (src) options.push(...columnOptions(cat, sourceColumns(src, cat), 50, ownerName(cat, src)));
        else if (rel) options.push(...columnOptions(cat, relColumns(rel), 50));
        if (cat.bySchema.has(q)) {
          options.push(...(cat.bySchema.get(q) ?? []).map((r) => relOption(cat, r, quoteIdent(r.name), 20)));
          options.push(...(cat.funcsBySchema.get(q) ?? []).map((f) => ({ label: quoteIdent(f.name), detail: `(${f.args})`, type: 'function', boost: 0 })));
        }
      } else if (qual.length === 2) {
        const rel = cat.resolve(qual[1], qual[0]);
        if (rel) options.push(...columnOptions(cat, relColumns(rel), 50));
      }
      return options.length ? { from, options, validFor: /^[\p{L}\p{N}_$]*$/u } : null;
    }

    // Types after :: or in DDL.
    if (prevKw === '::' || (prevKw && ['type', 'returns'].includes(prevKw)) || isColumnDefinition(tokensBefore)) {
      const types = cat.meta.types.filter(([s]) => s === 'pg_catalog' || cat.searchPath.includes(s)).map(([, t]) => t);
      return { from, options: [...new Set(types)].map((t) => ({ label: t, type: 'type' })), validFor: /^[\p{L}\p{N}_]*$/u };
    }

    const options: Completion[] = [];
    const inInsertCols = /\binsert\s+into\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s*\([^)]*$/i.exec(before);
    if (inInsertCols) {
      const p = splitQualified(inInsertCols[1]).map(unquote);
      const rel = p.length === 2 ? cat.resolve(p[1], p[0]) : cat.resolve(p[0]);
      if (rel) return { from, options: columnOptions(cat, relColumns(rel), 50), validFor: /^[\p{L}\p{N}_$]*$/u };
    }

    if (!prev) {
      options.push(...STARTERS.map((s) => ({ label: caseLike(s, last), type: 'keyword', boost: 10 })));
    } else if (prevKw && RELATION_KW.has(prevKw)) {
      if (prevKw === 'join') options.push(...joinOptions(cat, scope, wordStart, prev));
      options.push(...cteOptions(cat, scope, 35));
      options.push(...relationOptions(cat, 30));
      options.push(...cat.meta.schemas.filter((s) => !s.startsWith('pg_') || s === 'pg_catalog').map((s) => ({ label: quoteIdent(s), type: 'namespace', boost: 5 })));
      if (prevKw === 'from' || prevKw === 'join') options.push(...functionOptions(cat, -10));
    } else if (prevKw === ',' && inFromClause(tokensBefore)) {
      options.push(...cteOptions(cat, scope, 35));
      options.push(...relationOptions(cat, 30));
    } else {
      const columnContext = (prevKw && COLUMN_KW.has(prevKw)) || ['(', ',', '=', '<', '>', '+', '-', '*', '/', '||'].includes(prevKw ?? '');
      if (prevKw === 'on') options.push(...onConditions(cat, scope, prev.start, prev));
      if (prevKw === 'where') options.push(...correlatedConditions(cat, scope, prev));
      const seen = new Set<string>();
      if (prevKw === 'by' || (prevKw === ',' && inOrderBy(tokensBefore))) {
        // Output column names work in ORDER BY and GROUP BY.
        for (const it of scope.items) {
          if (!it.name || seen.has(it.name)) continue;
          seen.add(it.name);
          options.push({ label: quoteIdent(it.name), type: 'variable', detail: 'output column', boost: 45 });
        }
      }
      for (const o of scopeColumnOptions(cat, visible, columnContext ? 40 : 15)) {
        if (seen.has(o.label)) continue;
        seen.add(o.label);
        options.push(o);
      }
      for (const { src, depth } of visible) {
        const q = refName(src);
        if (!q || seen.has(q)) continue;
        seen.add(q);
        const detail = src.alias ? `alias for ${src.name || src.kind}` : src.kind === 'table' ? 'table' : src.kind;
        options.push({ label: quoteIdent(q), type: 'variable', detail, info: () => sourceView(cat, src), boost: 12 - depth });
      }
      options.push(...functionOptions(cat, columnContext ? 5 : -5));
      options.push(...relationOptions(cat, columnContext ? -10 : 0));
    }
    const kws = cat.meta.keywords.map(([w]) => w);
    options.push(...kws.map((k) => ({ label: caseLike(k, last), type: 'keyword', boost: !prev ? 5 : -2 })));
    return { from, options, validFor: /^[\p{L}\p{N}_$]*$/u };
  };
}

function isColumnDefinition(tokens: Token[]): boolean {
  // e.g. "create table t (id " or "add column x "
  const n = tokens.length;
  const t1 = tokens[n - 1];
  const t2 = tokens[n - 2];
  if (!t1 || !t2) return false;
  if (t2.text.toLowerCase() === 'column' && t1.kind === 'word') return true;
  if ((t2.text === '(' || t2.text === ',') && (t1.kind === 'word' || t1.kind === 'quoted')) {
    const head = tokens.slice(0, 3).map((t) => t.text.toLowerCase()).join(' ');
    return /^create (table|temp|temporary|unlogged)/.test(head);
  }
  return false;
}

function inFromClause(tokens: Token[]): boolean {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const w = tokens[i].kind === 'word' ? tokens[i].text.toLowerCase() : '';
    if (w === 'from') return true;
    if (w && ['select', 'where', 'join', 'on', 'group', 'order', 'set', 'values'].includes(w)) return false;
  }
  return false;
}

function inOrderBy(tokens: Token[]): boolean {
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.text === ')') depth++;
    else if (t.text === '(') {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0 && t.kind === 'word') {
      const w = t.text.toLowerCase();
      if (w === 'by') return ['order', 'group'].includes(tokens[i - 1]?.text.toLowerCase() ?? '');
      if (['select', 'from', 'where', 'having', 'limit', 'on'].includes(w)) return false;
    }
  }
  return false;
}

function splitQualified(word: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let q = false;
  for (const c of word) {
    if (c === '"') q = !q;
    if (c === '.' && !q) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function unquote(s: string): string {
  return s.startsWith('"') ? s.slice(1, s.endsWith('"') && s.length > 1 ? -1 : undefined).replace(/""/g, '"') : s.toLowerCase();
}

function relColumns(r: Relation): Column[] {
  return r.columns.map(([name, type, flags, comment]) => ({ name, type, flags: flags ?? undefined, comment: comment ?? undefined, rel: r }));
}

/** How a column's owner is shown: the table's name, or the alias of a derived table. */
function ownerName(cat: Catalog, src: Source): string | undefined {
  if (src.kind === 'table') {
    const rel = cat.resolve(src.name, src.schema);
    if (rel) return qualifiedName(cat, rel);
  }
  const q = refName(src);
  return q ? quoteIdent(q) : undefined;
}

export function sourceView(cat: Catalog, src: Source): HTMLElement {
  if (src.kind === 'table') {
    const rel = cat.resolve(src.name, src.schema);
    if (rel) return relationView(cat, rel, src.alias);
  }
  const label = src.kind === 'subquery' ? 'subquery' : src.kind === 'cte' ? 'cte' : src.kind === 'values' ? 'values' : src.kind === 'function' ? 'function' : 'table';
  const name = [src.name, src.alias].filter(Boolean).map((n) => quoteIdent(n!)).join(' ') || '(unnamed)';
  return derivedView(cat, label, name, sourceColumns(src, cat));
}

function relOption(cat: Catalog, r: Relation, label: string, boost: number): Completion {
  return {
    label,
    type: r.kind === 'v' || r.kind === 'm' ? 'interface' : 'class',
    detail: shortKind[r.kind] ?? r.kind,
    info: () => relationView(cat, r),
    boost,
  };
}

const shortKind: Record<string, string> = {
  r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign table', S: 'sequence',
};

function relationOptions(cat: Catalog, boost: number): Completion[] {
  const out: Completion[] = [];
  for (const r of cat.meta.relations) {
    if (r.schema === 'pg_catalog' || r.schema === 'information_schema') {
      // Only offer system relations when they're visible (pg_catalog is).
      if (r.schema === 'information_schema' || !r.name.startsWith('pg_')) continue;
    }
    const visible = cat.visible(r);
    out.push(relOption(cat, r, qualifiedName(cat, r), r.schema === 'pg_catalog' ? boost - 20 : visible ? boost : boost - 5));
  }
  return out;
}

function cteOptions(cat: Catalog, scope: Scope, boost: number): Completion[] {
  return visibleCtes(scope).map((c) => {
    const src: Source = { kind: 'cte', name: c.name, cte: c, body: c.body, start: c.start, end: c.end, nameStart: c.start, nameEnd: c.end };
    return { label: quoteIdent(c.name), type: 'class', detail: 'cte', info: () => sourceView(cat, src), boost };
  });
}

function columnOptions(cat: Catalog, cols: Column[], boost: number, owner?: string): Completion[] {
  // Keep table order among equally good matches.
  return cols.map((c, i) => ({
    label: quoteIdent(c.name),
    type: 'property',
    detail: c.type,
    info: () => columnView(cat, c, owner),
    boost: boost - Math.min(i, 90) / 100,
  }));
}

/**
 * Columns of the sources in scope. A name that more than one source at the
 * nearest level provides is offered qualified (u.id, o.id), since bare it
 * would be ambiguous.
 */
function scopeColumnOptions(cat: Catalog, visible: { src: Source; depth: number }[], boost: number): Completion[] {
  const byName = new Map<string, { src: Source; col: Column; depth: number; i: number }[]>();
  for (const { src, depth } of visible) {
    sourceColumns(src, cat).forEach((col, i) => {
      (byName.get(col.name) ?? byName.set(col.name, []).get(col.name)!).push({ src, col, depth, i });
    });
  }
  const out: Completion[] = [];
  for (const [name, entries] of byName) {
    const depth = Math.min(...entries.map((e) => e.depth));
    const near = entries.filter((e) => e.depth === depth);
    const b = boost - depth * 10;
    if (near.length === 1) {
      const { src, col, i } = near[0];
      out.push({ label: quoteIdent(name), type: 'property', detail: col.type, info: () => columnView(cat, col, ownerName(cat, src)), boost: b - Math.min(i, 90) / 100 });
      continue;
    }
    for (const { src, col, i } of near) {
      const q = refName(src);
      if (!q) continue;
      out.push({ label: `${quoteIdent(q)}.${quoteIdent(name)}`, type: 'property', detail: col.type, info: () => columnView(cat, col, ownerName(cat, src)), boost: b - 1 - Math.min(i, 90) / 100 });
    }
  }
  return out;
}

function functionOptions(cat: Catalog, boost: number): Completion[] {
  const out: Completion[] = [];
  const seen = new Set<string>();
  for (const s of cat.searchPath) {
    for (const f of cat.funcsBySchema.get(s) ?? []) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({
        label: quoteIdent(f.name),
        type: 'function',
        detail: f.kind === 'a' ? 'aggregate' : f.kind === 'w' ? 'window' : f.kind === 'p' ? 'procedure' : 'function',
        info: () => functionView(cat.functions(f.name, f.schema)),
        boost: s === 'pg_catalog' ? boost - 3 : boost,
      });
    }
  }
  return out;
}

/** The column list a star stands for, or undefined if it can't be worked out. */
function expandStar(cat: Catalog, scope: Scope, star: true | string[]): string | undefined {
  const srcs = star === true ? scope.sources : [findSource(scope, star[star.length - 1])].filter((s): s is Source => !!s);
  const qualify = star !== true || srcs.length > 1;
  const names: string[] = [];
  for (const src of srcs) {
    const q = refName(src);
    for (const c of sourceColumns(src, cat)) names.push(qualify && q ? `${quoteIdent(q)}.${quoteIdent(c.name)}` : quoteIdent(c.name));
  }
  return names.length ? names.join(', ') : undefined;
}

// ---- joins ----

interface Side {
  src: Source;
  rel?: Relation;
  /** How the source is referenced: its alias or name, quoted as needed. */
  q: string;
}

function side(cat: Catalog, src: Source): Side | undefined {
  const r = refName(src);
  if (!r) return undefined;
  return { src, rel: src.kind === 'table' ? cat.resolve(src.name, src.schema) : undefined, q: quoteIdent(r) };
}

/** Join conditions between a newly joined `right` and an earlier `left`, along foreign keys. */
function fkConditions(cat: Catalog, right: Side, left: Side): { pairs: string[]; fk: ForeignKeyRef }[] {
  const out: { pairs: string[]; fk: ForeignKeyRef }[] = [];
  if (!right.rel || !left.rel) return out;
  const eq = (a: string, b: string) => `${right.q}.${quoteIdent(a)} = ${left.q}.${quoteIdent(b)}`;
  const fksFrom = (r: Relation) => cat.fksFrom.get(r) ?? [];
  for (const fk of fksFrom(right.rel)) if (fk.to === left.rel) out.push({ pairs: fk.columns.map((c, i) => eq(c, fk.refColumns[i])), fk });
  for (const fk of fksFrom(left.rel)) if (fk.to === right.rel) out.push({ pairs: fk.refColumns.map((c, i) => eq(c, fk.columns[i])), fk });
  return out;
}

/** Equal *_id style column names, for joins the catalog has no foreign key for. */
function nameConditions(cat: Catalog, right: Side, left: Side): string[] {
  const leftCols = new Set(sourceColumns(left.src, cat).map((c) => c.name));
  return sourceColumns(right.src, cat)
    .map((c) => c.name)
    .filter((n) => leftCols.has(n) && /.id$/i.test(n) && n.toLowerCase() !== 'id')
    .map((n) => `${right.q}.${quoteIdent(n)} = ${left.q}.${quoteIdent(n)}`);
}

function conditionOptions(cat: Catalog, right: Side, lefts: Side[], andTok: Token | undefined, boost: number): Completion[] {
  const AND = ` ${caseOf(andTok, 'and')} `;
  const out: Completion[] = [];
  const seen = new Set<string>();
  const add = (c: Completion) => {
    if (seen.has(c.label)) return;
    seen.add(c.label);
    out.push(c);
  };
  lefts.forEach((left, i) => {
    for (const { pairs, fk } of fkConditions(cat, right, left)) {
      add({ label: pairs.join(AND), type: 'text', detail: 'foreign key', info: `${fk.name}: ${qualifiedName(cat, fk.from)} (${fk.columns.map((c) => quoteIdent(c)).join(', ')}) → ${qualifiedName(cat, fk.to)} (${fk.refColumns.map((c) => quoteIdent(c)).join(', ')})`, boost: boost - i });
    }
    for (const cond of nameConditions(cat, right, left)) add({ label: cond, type: 'text', detail: 'same name', boost: boost - 5 - i });
  });
  return out;
}

/** After ON: conditions joining the item just before ON to the ones before it. */
function onConditions(cat: Catalog, scope: Scope, onStart: number, onTok: Token): Completion[] {
  const before = scope.sources.filter((s) => s.end <= onStart);
  const right = before.length ? side(cat, before[before.length - 1]) : undefined;
  if (!right) return [];
  const lefts = before.slice(0, -1).reverse().map((s) => side(cat, s)).filter((s): s is Side => !!s);
  return conditionOptions(cat, right, lefts, onTok, 50);
}

/** WHERE in a subquery: conditions correlating its tables with the outer query's. */
function correlatedConditions(cat: Catalog, scope: Scope, whereTok: Token): Completion[] {
  const parent = scope.parent;
  if (!parent || parent.sources.some((s) => s.body === scope)) return [];
  const outer = visibleSources(parent).map(({ src }) => side(cat, src)).filter((s): s is Side => !!s);
  return scope.sources.flatMap((s) => {
    const right = side(cat, s);
    return right ? conditionOptions(cat, right, outer, whereTok, 45) : [];
  });
}

/** An alias from a table name's initials (order_items → oi), unique in the statement. */
export function makeAlias(name: string, taken: Set<string>, keywords?: Set<string>): string {
  const words = name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).filter(Boolean);
  let base = words.map((w) => w[0]).join('').toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(base)) base = 't';
  let alias = base;
  for (let n = 2; taken.has(alias) || isReserved(alias) || keywords?.has(alias); n++) alias = base + n;
  return alias;
}

/** After JOIN: tables linked by a foreign key to one already in FROM, with the ON clause. */
function joinOptions(cat: Catalog, scope: Scope, wordStart: number, joinTok: Token): Completion[] {
  const lefts = scope.sources.filter((s) => s.end <= wordStart);
  if (!lefts.length) return [];
  const taken = new Set(visibleSources(scope).map(({ src }) => refName(src)).filter((n): n is string => !!n));
  const useAliases = lefts.some((s) => s.alias);
  const ON = caseOf(joinTok, 'on');
  const AND = ` ${caseOf(joinTok, 'and')} `;
  const out: Completion[] = [];
  const seen = new Set<string>();
  [...lefts].reverse().forEach((src, i) => {
    const left = side(cat, src);
    if (!left?.rel) return;
    const links: { to: Relation; pairs: (tq: string) => string[]; fk: ForeignKeyRef }[] = [];
    for (const fk of cat.fksFrom.get(left.rel) ?? []) {
      links.push({ to: fk.to, fk, pairs: (tq) => fk.columns.map((c, k) => `${tq}.${quoteIdent(fk.refColumns[k])} = ${left.q}.${quoteIdent(c)}`) });
    }
    for (const fk of cat.fksTo.get(left.rel) ?? []) {
      links.push({ to: fk.from, fk, pairs: (tq) => fk.refColumns.map((c, k) => `${tq}.${quoteIdent(fk.columns[k])} = ${left.q}.${quoteIdent(c)}`) });
    }
    for (const { to, pairs, fk } of links) {
      const alias = useAliases || taken.has(to.name) ? makeAlias(to.name, taken, cat.keywords) : undefined;
      const label = `${qualifiedName(cat, to)}${alias ? ` ${alias}` : ''} ${ON} ${pairs(alias ?? quoteIdent(to.name)).join(AND)}`;
      if (seen.has(label)) continue;
      seen.add(label);
      const info = () => {
        const v = relationView(cat, to);
        v.prepend(noteLine(`joined along ${fk.name}`));
        return v;
      };
      out.push({ label, type: 'class', detail: 'join', info, boost: 40 - i });
    }
  });
  return out;
}
