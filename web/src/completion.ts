// Context-aware completions in the spirit of pgcli: tables after FROM/JOIN,
// columns of the tables (and aliases) in scope, schema-qualified names,
// types after ::, and backslash commands with their arguments.

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { Meta, Relation } from './types';
import { identName, quoteIdent, scan, statementRange, type Token } from './sqlscan';

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
const NOT_ALIAS = new Set([
  'where', 'join', 'on', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'group', 'order', 'limit',
  'set', 'using', 'values', 'select', 'having', 'union', 'intersect', 'except', 'lateral', 'window', 'offset',
  'fetch', 'for', 'returning', 'default', 'tablesample', 'with', 'as',
]);
const STARTERS = [
  'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'CREATE', 'ALTER', 'DROP', 'EXPLAIN', 'EXPLAIN ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SHOW', 'SET', 'TRUNCATE', 'GRANT', 'REVOKE', 'VACUUM', 'ANALYZE', 'COPY', 'TABLE',
  'VALUES', 'CALL', 'DO', 'LISTEN', 'NOTIFY', 'COMMENT ON', 'REFRESH MATERIALIZED VIEW', 'REINDEX', 'RESET', 'CLUSTER',
];

interface TableRef {
  schema?: string;
  name: string;
  alias?: string;
}

/** Find table references (FROM/JOIN/UPDATE/INTO) in a statement's tokens. */
export function tableRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = [];
  const isName = (t?: Token) => !!t && (t.kind === 'word' || t.kind === 'quoted');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    const kw = t.text.toLowerCase();
    if (!['from', 'join', 'update', 'into'].includes(kw)) continue;
    let j = i + 1;
    for (;;) {
      if (tokens[j]?.kind === 'word' && tokens[j].text.toLowerCase() === 'only') j++;
      if (!isName(tokens[j])) break;
      let schema: string | undefined;
      let name = identName(tokens[j]);
      j++;
      if (tokens[j]?.text === '.' && isName(tokens[j + 1])) {
        schema = name;
        name = identName(tokens[j + 1]);
        j += 2;
      }
      let alias: string | undefined;
      if (tokens[j]?.kind === 'word' && tokens[j].text.toLowerCase() === 'as') j++;
      if (isName(tokens[j]) && !(tokens[j].kind === 'word' && NOT_ALIAS.has(tokens[j].text.toLowerCase()))) {
        alias = identName(tokens[j]);
        j++;
      }
      refs.push({ schema, name, alias });
      if (kw === 'from' && tokens[j]?.text === ',') {
        j++;
        continue;
      }
      break;
    }
  }
  return refs;
}

export class Catalog {
  byName = new Map<string, Relation[]>();
  bySchema = new Map<string, Relation[]>();
  funcsBySchema = new Map<string, Meta['functions']>();
  keywords: Set<string>;
  searchPath: string[];

  constructor(public meta: Meta) {
    for (const r of meta.relations) {
      (this.byName.get(r.name) ?? this.byName.set(r.name, []).get(r.name)!).push(r);
      (this.bySchema.get(r.schema) ?? this.bySchema.set(r.schema, []).get(r.schema)!).push(r);
    }
    for (const f of meta.functions) {
      (this.funcsBySchema.get(f.schema) ?? this.funcsBySchema.set(f.schema, []).get(f.schema)!).push(f);
    }
    this.keywords = new Set(meta.keywords.filter(([, c]) => c === 'R' || c === 'T').map(([w]) => w));
    this.searchPath = meta.search_path;
  }

  /** Resolve a possibly unqualified name the way search_path would. */
  resolve(name: string, schema?: string): Relation | undefined {
    const cands = this.byName.get(name);
    if (!cands) return undefined;
    if (schema) return cands.find((r) => r.schema === schema);
    for (const s of this.searchPath) {
      const r = cands.find((r) => r.schema === s);
      if (r) return r;
    }
    return undefined;
  }

  visible(r: Relation): boolean {
    return this.resolve(r.name) === r;
  }
}

const kindLabel: Record<string, string> = {
  r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign table', S: 'sequence',
};

function caseLike(word: string, typed: string): string {
  return typed && typed === typed.toLowerCase() && /[a-z]/.test(typed) ? word.toLowerCase() : word.toUpperCase();
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
        return { from, options: functionOptions(cat, word, 0) };
      }
      if (base === '\\dn') return { from, options: cat.meta.schemas.map((s) => ({ label: s, type: 'namespace' })) };
      if (base === '\\du' || base === '\\dg') return { from, options: cat.meta.roles.map((s) => ({ label: s, type: 'variable' })) };
      if (base.startsWith('\\d') || base === '\\sv' || base === '\\z') {
        return { from, options: relationOptions(cat, word, 0) };
      }
      return null;
    }

    const wordMatch = /(?:(?:"(?:[^"]|"")*"|[\p{L}\p{N}_$]+)\.)*(?:"(?:[^"]|"")*"?|[\p{L}\p{N}_$]*)$/u.exec(before);
    const word = wordMatch ? wordMatch[0] : '';
    if (!word && !ctx.explicit) {
      return null;
    }
    const parts = splitQualified(word);
    const last = parts[parts.length - 1];
    const from = pos - last.length;
    const tokensBefore = sc.tokens.filter((t) => t.end <= pos - word.length);
    const prev = tokensBefore[tokensBefore.length - 1];
    const prevKw = prev?.kind === 'word' ? prev.text.toLowerCase() : prev?.text;
    if (prev?.kind === 'number' && word === '') return null;

    if (!cat) {
      return prev ? null : { from, options: STARTERS.map((s) => ({ label: caseLike(s, last), type: 'keyword' })) };
    }

    const stmtTokens = scan(doc.slice(stmtStart, stmtEnd)).tokens;
    const refs = tableRefs(stmtTokens);

    // Qualified: alias.col, table.col, schema.table
    if (parts.length > 1) {
      const qual = parts.slice(0, -1).map(unquote);
      const options: Completion[] = [];
      if (qual.length === 1) {
        const q = qual[0];
        const ref = refs.find((r) => r.alias === q) ?? refs.find((r) => r.name === q && !r.alias);
        const rel = ref ? cat.resolve(ref.name, ref.schema) : cat.resolve(q);
        if (rel) options.push(...columnOptions(rel, 50));
        if (cat.bySchema.has(q)) {
          options.push(...(cat.bySchema.get(q) ?? []).map((r) => relOption(r, r.name, 20)));
          options.push(...(cat.funcsBySchema.get(q) ?? []).map((f) => ({ label: quoteIdent(f.name), detail: `(${f.args})`, type: 'function', boost: 0 })));
        }
      } else if (qual.length === 2) {
        const rel = cat.resolve(qual[1], qual[0]);
        if (rel) options.push(...columnOptions(rel, 50));
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
      if (rel) return { from, options: columnOptions(rel, 50), validFor: /^[\p{L}\p{N}_$]*$/u };
    }

    if (!prev) {
      options.push(...STARTERS.map((s) => ({ label: caseLike(s, last), type: 'keyword', boost: 10 })));
    } else if (prevKw && RELATION_KW.has(prevKw)) {
      options.push(...relationOptions(cat, '', 30));
      options.push(...cat.meta.schemas.filter((s) => !s.startsWith('pg_') || s === 'pg_catalog').map((s) => ({ label: quoteIdent(s), type: 'namespace', boost: 5 })));
      if (prevKw === 'from' || prevKw === 'join') options.push(...functionOptions(cat, '', -10));
    } else if (prevKw === ',' && inFromClause(tokensBefore)) {
      options.push(...relationOptions(cat, '', 30));
    } else {
      const columnContext = (prevKw && COLUMN_KW.has(prevKw)) || ['(', ',', '=', '<', '>', '+', '-', '*', '/', '||'].includes(prevKw ?? '');
      const seen = new Set<string>();
      for (const r of refs) {
        const rel = cat.resolve(r.name, r.schema);
        if (!rel) continue;
        for (const o of columnOptions(rel, columnContext ? 40 : 15)) {
          if (seen.has(o.label)) continue;
          seen.add(o.label);
          options.push(o);
        }
        if (r.alias) options.push({ label: r.alias, type: 'variable', detail: `alias for ${r.name}`, boost: 12 });
      }
      options.push(...functionOptions(cat, '', columnContext ? 5 : -5));
      options.push(...relationOptions(cat, '', columnContext ? -10 : 0));
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

function relOption(r: Relation, label: string, boost: number): Completion {
  return { label, type: r.kind === 'v' || r.kind === 'm' ? 'interface' : 'class', detail: kindLabel[r.kind] ?? r.kind, boost };
}

function relationOptions(cat: Catalog, _typed: string, boost: number): Completion[] {
  const out: Completion[] = [];
  for (const r of cat.meta.relations) {
    if (r.schema === 'pg_catalog' || r.schema === 'information_schema') {
      // Only offer system relations when they're visible (pg_catalog is).
      if (r.schema === 'information_schema' || !r.name.startsWith('pg_')) continue;
    }
    const visible = cat.visible(r);
    const label = visible ? quoteIdent(r.name) : `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`;
    out.push(relOption(r, label, r.schema === 'pg_catalog' ? boost - 20 : visible ? boost : boost - 5));
  }
  return out;
}

function columnOptions(r: Relation, boost: number): Completion[] {
  // Keep table order among equally good matches.
  return r.columns.map(([name, type], i) => ({
    label: quoteIdent(name),
    type: 'property',
    detail: type,
    info: `${r.schema}.${r.name}`,
    boost: boost - Math.min(i, 90) / 100,
  }));
}

function functionOptions(cat: Catalog, _typed: string, boost: number): Completion[] {
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
        info: `${f.schema}.${f.name}(${f.args})`,
        boost: s === 'pg_catalog' ? boost - 3 : boost,
      });
    }
  }
  return out;
}
