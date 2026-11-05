// A tolerant scope analyser over sqlscan tokens: enough structure for
// completions and hover, without a full grammar. It finds query levels
// (subqueries, CTE bodies, set-operation branches), the FROM items of each
// level (tables, CTE references, derived tables, table functions, VALUES)
// with their aliases and column alias lists, and the select list of each
// level so the columns of derived tables and CTEs are known.
//
// It never fails: unbalanced parentheses run to the end of the text, and
// anything it doesn't understand is skipped.

import { identName, type Token } from './sqlscan';
import type { Relation } from './types';

export type CatalogRelation = Relation;

export type SourceKind = 'table' | 'cte' | 'subquery' | 'function' | 'values';

export interface Source {
  kind: SourceKind;
  /** Schema qualifier as written (tables and functions). */
  schema?: string;
  /** Table, CTE or function name; empty for subqueries and VALUES. */
  name: string;
  alias?: string;
  columnAliases?: string[];
  /** The query of a derived table, or the CTE body (its first branch). */
  body?: Scope;
  /** The CTE this source refers to. */
  cte?: Cte;
  /** Text range of the whole FROM item, alias included. */
  start: number;
  end: number;
  /** Text range of the name (or the parenthesised part) only. */
  nameStart: number;
  nameEnd: number;
}

export interface Cte {
  name: string;
  columnAliases?: string[];
  body?: Scope;
  start: number;
  end: number;
}

export interface SelectItem {
  /** Output column name, if PostgreSQL would give it a real one. */
  name?: string;
  /** `*` (true) or `qual.*` (the qualifier parts). */
  star?: true | string[];
  /** The item is a plain column reference (possibly qualified, possibly cast). */
  ref?: string[];
  start: number;
  end: number;
}

export interface Scope {
  /** Text range of this query level (inside its parentheses). */
  start: number;
  end: number;
  parent?: Scope;
  ctes: Cte[];
  sources: Source[];
  items: SelectItem[];
  children: Scope[];
  /** The leading keyword: select, insert, update, delete, merge, values, … */
  verb?: string;
}

export interface Column {
  name: string;
  type: string;
  /** Flags from the catalog: n = not null, p = primary key, d = has default. */
  flags?: string;
  comment?: string;
  /** The catalog relation the column comes from, when known. */
  rel?: CatalogRelation;
}

export interface CatalogLike {
  resolve(name: string, schema?: string): CatalogRelation | undefined;
}

// Reserved words (plus a few that can't start or name a FROM item in practice).
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check',
  'collate', 'column', 'constraint', 'create', 'current_catalog', 'current_date', 'current_role', 'current_time',
  'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except',
  'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into',
  'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not', 'null', 'offset', 'on', 'only', 'or', 'order',
  'placing', 'primary', 'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'system_user',
  'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where', 'window',
  'with',
  // Not reserved, but they follow a FROM item rather than alias it.
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'set', 'values', 'tablesample', 'overriding',
  'inherit', 'default', 'conflict', 'matched', 'is', 'isnull', 'notnull', 'like', 'ilike', 'similar', 'between',
]);

/** Words that can't be an alias (or a table name) where one might appear. */
export function isReserved(word: string): boolean {
  return RESERVED.has(word.toLowerCase());
}

const QUERY_START = new Set(['select', 'with', 'values', 'table']);
const CLAUSES = new Set([
  'select', 'from', 'where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch', 'for', 'returning',
  'set', 'values', 'on', 'using', 'join', 'by',
]);

class Parser {
  close: number[];

  constructor(
    public toks: Token[],
    public textLen: number,
  ) {
    // Matching ')' for every '(' (or toks.length when unbalanced).
    this.close = new Array(toks.length).fill(-1);
    const stack: number[] = [];
    toks.forEach((t, i) => {
      if (t.text === '(' && t.kind === 'punct') stack.push(i);
      else if (t.text === ')' && t.kind === 'punct' && stack.length) this.close[stack.pop()!] = i;
    });
    for (const i of stack) this.close[i] = toks.length;
  }

  word(i: number): string | undefined {
    const t = this.toks[i];
    return t?.kind === 'word' ? t.text.toLowerCase() : undefined;
  }

  is(i: number, text: string): boolean {
    const t = this.toks[i];
    return !!t && (t.kind === 'punct' || t.kind === 'op') && t.text === text;
  }

  /** An identifier that can name a relation or alias here. */
  isName(i: number): boolean {
    const t = this.toks[i];
    if (!t) return false;
    if (t.kind === 'quoted') return true;
    return t.kind === 'word' && !RESERVED.has(t.text.toLowerCase());
  }

  /** Start offset of token i, or end of text. */
  at(i: number): number {
    return this.toks[i]?.start ?? this.textLen;
  }

  /** End offset of the token before i. */
  endBefore(i: number): number {
    const k = Math.min(i, this.toks.length);
    return k > 0 ? this.toks[k - 1].end : 0;
  }

  /** Closing paren index → text offset where the parenthesised content ends. */
  closeAt(c: number): number {
    return c < this.toks.length ? this.toks[c].start : this.textLen;
  }

  isQueryStart(i: number): boolean {
    const w = this.word(i);
    if (w && QUERY_START.has(w)) return true;
    // ((select …)) and similar.
    return this.is(i, '(') && this.isQueryStart(i + 1);
  }

  /** Identifiers in a parenthesised list: (a, b, "C"). */
  nameList(open: number): string[] {
    const out: string[] = [];
    const c = this.close[open];
    let expect = true;
    for (let k = open + 1; k < c; k++) {
      const t = this.toks[k];
      if (this.is(k, '(')) {
        k = this.close[k];
        continue;
      }
      if (t.text === ',' && t.kind === 'punct') expect = true;
      else if (expect && (t.kind === 'word' || t.kind === 'quoted')) {
        out.push(identName(t));
        expect = false;
      }
    }
    return out;
  }

  lookupCte(scope: Scope, name: string): Cte | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const c = s.ctes.find((c) => c.name === name);
      if (c) return c;
    }
    return undefined;
  }

  newScope(parent: Scope | undefined, start: number, end: number, ctes?: Cte[]): Scope {
    const s: Scope = { start, end, parent, ctes: ctes ?? [], sources: [], items: [], children: [] };
    parent?.children.push(s);
    return s;
  }

  /** Look inside non-query parentheses for nested queries. */
  nested(open: number, scope: Scope) {
    const c = this.close[open];
    for (let k = open + 1; k < c; k++) {
      if (!this.is(k, '(')) continue;
      this.paren(k, scope);
      k = this.close[k];
    }
  }

  /** A parenthesised group in an expression: a subquery or anything else. */
  paren(open: number, scope: Scope) {
    if (this.isQueryStart(open + 1)) this.query(open + 1, this.close[open], scope, this.toks[open].end, this.closeAt(this.close[open]));
    else this.nested(open, scope);
  }

  /**
   * Parse one query level from token i up to (not including) token `end`.
   * Returns its scope (the first branch of a set operation).
   */
  query(i: number, end: number, parent: Scope | undefined, start: number, endPos: number, ctes?: Cte[]): Scope {
    const scope = this.newScope(parent, start, endPos, ctes);
    let j = i;
    // Redundant parentheses around a whole query: ((select …) union …).
    if (this.is(j, '(') && this.isQueryStart(j + 1) && this.close[j] < end) {
      const inner = this.query(j + 1, this.close[j], scope, this.toks[j].end, this.closeAt(this.close[j]));
      scope.items = inner.items;
      j = this.close[j] + 1;
    }
    if (this.word(j) === 'with') j = this.withClause(j + 1, end, scope);
    if (this.word(j) === 'explain') {
      j++;
      if (this.is(j, '(')) j = this.close[j] + 1;
      while (this.word(j) === 'analyze' || this.word(j) === 'analyse' || this.word(j) === 'verbose') j++;
    }
    const verbAt = j;
    scope.verb = this.word(j);
    let clause = '';
    let itemStart = -1;
    const finishItem = (k: number) => {
      if (itemStart >= 0 && k > itemStart) scope.items.push(this.selectItem(itemStart, k));
      itemStart = -1;
    };
    while (j < end) {
      const t = this.toks[j];
      if (this.is(j, '(')) {
        this.paren(j, scope);
        j = this.close[j] + 1;
        continue;
      }
      if (t.kind === 'punct' && t.text === ',') {
        if (clause === 'select') {
          finishItem(j);
          itemStart = j + 1;
        } else if (clause === 'from' || clause === 'on') {
          clause = 'from';
          j = this.fromItem(j + 1, end, scope);
          continue;
        }
        j++;
        continue;
      }
      const w = this.word(j);
      if (!w) {
        j++;
        continue;
      }
      if (w === 'union' || w === 'intersect' || w === 'except') {
        finishItem(j);
        scope.end = t.start;
        let k = j + 1;
        if (this.word(k) === 'all' || this.word(k) === 'distinct') k++;
        // The next branch is a sibling level that shares this level's CTEs.
        this.query(k, end, parent, this.at(k), endPos, scope.ctes);
        return scope;
      }
      if (clause === 'select' && CLAUSES.has(w) && w !== 'by' && w !== 'on') finishItem(j);
      switch (w) {
        case 'select':
          clause = 'select';
          j++;
          if (this.word(j) === 'all') j++;
          else if (this.word(j) === 'distinct') {
            j++;
            if (this.word(j) === 'on' && this.is(j + 1, '(')) {
              this.nested(j + 1, scope);
              j = this.close[j + 1] + 1;
            }
          }
          itemStart = j;
          continue;
        case 'from':
          if (scope.verb === 'delete' && clause === '') {
            // DELETE FROM target
            clause = 'target';
            j = this.fromItem(j + 1, end, scope, true);
            continue;
          }
          clause = 'from';
          j = this.fromItem(j + 1, end, scope);
          continue;
        case 'join':
          clause = 'from';
          j = this.fromItem(j + 1, end, scope);
          continue;
        case 'using':
          if ((scope.verb === 'delete' && clause === 'target') || (scope.verb === 'merge' && clause === 'target')) {
            clause = 'from';
            j = this.fromItem(j + 1, end, scope);
            continue;
          }
          break;
        case 'into':
          if ((scope.verb === 'insert' || scope.verb === 'merge') && clause === '') {
            clause = 'target';
            j = this.fromItem(j + 1, end, scope, true);
            continue;
          }
          break;
        case 'update':
          if (scope.verb === 'update' && clause === '') {
            clause = 'target';
            j = this.fromItem(j + 1, end, scope, true);
            continue;
          }
          break;
        case 'table':
          // TABLE t, ALTER TABLE t, TRUNCATE [TABLE] t, LOCK [TABLE] t
          if (clause === '' && ['table', 'alter', 'truncate', 'lock'].includes(scope.verb ?? '')) {
            clause = 'target';
            let k = j + 1;
            if (this.word(k) === 'if' && this.word(k + 1) === 'exists') k += 2;
            j = this.fromItem(k, end, scope, true);
            continue;
          }
          break;
        case 'on':
          if (scope.verb === 'create' && clause === 'index') {
            clause = 'target';
            j = this.fromItem(j + 1, end, scope, true);
            continue;
          }
          if (clause === 'from') clause = 'on';
          break;
        case 'index':
          if (scope.verb === 'create') clause = 'index';
          break;
        default:
          if (CLAUSES.has(w) && w !== 'by') clause = w;
      }
      // TRUNCATE t / LOCK t without TABLE.
      if (clause === '' && j === verbAt && (w === 'truncate' || w === 'lock')) {
        clause = 'target';
        j = this.word(j + 1) === 'table' ? j + 1 : this.fromItem(j + 1, end, scope, true);
        continue;
      }
      j++;
    }
    finishItem(j);
    return scope;
  }

  withClause(j: number, end: number, scope: Scope): number {
    if (this.word(j) === 'recursive') j++;
    while (j < end && (this.toks[j]?.kind === 'word' || this.toks[j]?.kind === 'quoted')) {
      const nameTok = this.toks[j];
      const cte: Cte = { name: identName(nameTok), start: nameTok.start, end: nameTok.end };
      scope.ctes.push(cte);
      j++;
      if (this.is(j, '(')) {
        cte.columnAliases = this.nameList(j);
        j = this.close[j] + 1;
      }
      if (this.word(j) !== 'as') return j;
      j++;
      if (this.word(j) === 'not') j++;
      if (this.word(j) === 'materialized') j++;
      if (!this.is(j, '(')) return j;
      const c = this.close[j];
      cte.body = this.query(j + 1, c, scope, this.toks[j].end, this.closeAt(c));
      cte.end = this.closeAt(c);
      j = c + 1;
      // SEARCH / CYCLE clauses
      while (j < end && (this.word(j) === 'search' || this.word(j) === 'cycle')) {
        while (j < end && !this.is(j, ',') && !QUERY_START.has(this.word(j) ?? '') && this.word(j) !== 'insert' && this.word(j) !== 'update' && this.word(j) !== 'delete' && this.word(j) !== 'merge') j++;
      }
      if (!this.is(j, ',')) return j;
      j++;
    }
    return j;
  }

  /**
   * Parse a FROM item at token j and add it to the scope. With `target`, the
   * item is a DML target: no column alias list follows.
   */
  fromItem(j: number, end: number, scope: Scope, target = false): number {
    while (this.word(j) === 'only' || this.word(j) === 'lateral') j++;
    if (j >= end) return j;
    const startTok = j;
    let src: Source | undefined;
    if (this.is(j, '(')) {
      const c = this.close[j];
      if (this.isQueryStart(j + 1)) {
        const body = this.query(j + 1, c, scope, this.toks[j].end, this.closeAt(c));
        const kind = this.word(j + 1) === 'values' ? 'values' : 'subquery';
        src = { kind, name: '', body, start: this.at(startTok), end: 0, nameStart: this.toks[j].start, nameEnd: c < this.toks.length ? this.toks[c].end : this.textLen };
        j = c + 1;
      } else {
        // A parenthesised join: (a JOIN b ON …)
        let k = this.fromItem(j + 1, c, scope);
        while (k < c) {
          if (this.word(k) === 'join' || this.is(k, ',')) k = this.fromItem(k + 1, c, scope);
          else if (this.is(k, '(')) {
            this.paren(k, scope);
            k = this.close[k] + 1;
          } else k++;
        }
        j = c + 1;
        // An alias for a parenthesised join hides the joined tables; ignore it.
        if (this.word(j) === 'as') j++;
        if (this.isName(j)) j++;
        return j;
      }
    } else if (this.isName(j)) {
      let schema: string | undefined;
      let name = identName(this.toks[j]);
      const nameStart = this.toks[j].start;
      j++;
      if (this.is(j, '.') && (this.toks[j + 1]?.kind === 'word' || this.toks[j + 1]?.kind === 'quoted')) {
        schema = name;
        name = identName(this.toks[j + 1]);
        j += 2;
        // db.schema.table
        if (this.is(j, '.') && (this.toks[j + 1]?.kind === 'word' || this.toks[j + 1]?.kind === 'quoted')) {
          schema = name;
          name = identName(this.toks[j + 1]);
          j += 2;
        }
      }
      const nameEnd = this.toks[j - 1].end;
      if (this.is(j, '(') && !target) {
        // Table function, possibly WITH ORDINALITY / ROWS FROM.
        this.nested(j, scope);
        j = this.close[j] + 1;
        src = { kind: 'function', schema, name, start: nameStart, end: 0, nameStart, nameEnd };
        if (this.word(j) === 'with' && this.word(j + 1) === 'ordinality') j += 2;
      } else {
        const cte = schema ? undefined : this.lookupCte(scope, name);
        src = cte
          ? { kind: 'cte', name, cte, body: cte.body, start: nameStart, end: 0, nameStart, nameEnd }
          : { kind: 'table', schema, name, start: nameStart, end: 0, nameStart, nameEnd };
        if (this.is(j, '*')) j++;
      }
    } else return j;

    if (this.word(j) === 'as') j++;
    if (this.isName(j)) {
      src.alias = identName(this.toks[j]);
      j++;
    }
    if (!target && this.is(j, '(')) {
      src.columnAliases = this.nameList(j);
      j = this.close[j] + 1;
    }
    src.end = this.endBefore(j);
    scope.sources.push(src);
    return j;
  }

  selectItem(a: number, b: number): SelectItem {
    const toks = this.toks.slice(a, b);
    const item: SelectItem = { start: toks[0]?.start ?? 0, end: toks[toks.length - 1]?.end ?? 0 };
    if (!toks.length) return item;
    const isNameTok = (t?: Token) => !!t && (t.kind === 'quoted' || t.kind === 'word');
    let n = toks.length;
    // Explicit alias: … AS name, or … name after a complete expression.
    const last = toks[n - 1];
    const prev = toks[n - 2];
    if (isNameTok(last) && n >= 2) {
      const prevWord = prev.kind === 'word' ? prev.text.toLowerCase() : '';
      if (prevWord === 'as') {
        item.name = identName(last);
        n -= 2;
      } else if (
        !(last.kind === 'word' && RESERVED.has(last.text.toLowerCase())) &&
        (prev.kind === 'word' || prev.kind === 'quoted' || prev.kind === 'number' || prev.kind === 'string' || prev.text === ')') &&
        !(prevWord && RESERVED.has(prevWord) && prevWord !== 'end') &&
        !(last.kind === 'word' && ['precision', 'varying', 'zone'].includes(last.text.toLowerCase()))
      ) {
        item.name = identName(last);
        n -= 1;
      }
    }
    const body = toks.slice(0, n);
    // Strip a trailing cast: x::type, x::type(1), x::schema.type[]
    let core = body;
    const castAt = body.findIndex((t) => t.text === '::');
    if (castAt > 0) core = body.slice(0, castAt);
    // Column reference: a.b.c, or star.
    if (core.length && core.every((t, k) => (k % 2 === 0 ? isNameTok(t) || (t.text === '*' && k === core.length - 1) : t.text === '.'))) {
      const parts = core.filter((_, k) => k % 2 === 0);
      if (parts[parts.length - 1].text === '*') {
        item.star = parts.length === 1 ? true : parts.slice(0, -1).map(identName);
        return item;
      }
      if (!(parts.length === 1 && parts[0].kind === 'word' && RESERVED.has(parts[0].text.toLowerCase()))) {
        item.ref = parts.map(identName);
        item.name ??= item.ref[item.ref.length - 1];
      }
      return item;
    }
    if (core.length === 1 && core[0].text === '*') {
      item.star = true;
      return item;
    }
    // Function call: name(…) or schema.name(…)
    if (!item.name && core.length >= 3 && isNameTok(core[0])) {
      let k = 1;
      if (core[k]?.text === '.' && isNameTok(core[k + 1])) k += 2;
      const open = a + k;
      if (this.is(open, '(') && this.close[open] === a + core.length - 1) item.name = identName(core[k - 1]);
    }
    if (!item.name && core.length && core[0].kind === 'word') {
      const w = core[0].text.toLowerCase();
      if (w === 'case' && core[core.length - 1].text.toLowerCase() === 'end') item.name = 'case';
      else if (w === 'exists') item.name = 'exists';
      else if (w === 'array') item.name = 'array';
      else if (['coalesce', 'greatest', 'least', 'nullif', 'row'].includes(w)) item.name = w;
    }
    return item;
  }
}

/**
 * Analyse a statement's tokens; positions are offsets in the scanned text.
 * The root is a wrapper whose children are the top-level query (and the
 * further branches of a top-level set operation).
 */
export function analyze(tokens: Token[], textLen: number): Scope {
  const p = new Parser(tokens, textLen);
  const root: Scope = { start: 0, end: textLen, ctes: [], sources: [], items: [], children: [] };
  const top = p.query(0, tokens.length, root, 0, textLen);
  root.items = top.items;
  root.verb = top.verb;
  return root;
}

/** The innermost query level containing `pos`. */
export function scopeAt(root: Scope, pos: number): Scope {
  for (const c of root.children) {
    if (c.start <= pos && pos <= c.end) return scopeAt(c, pos);
  }
  return root;
}

/** The name a source is referenced by in the query. */
export function refName(s: Source): string | undefined {
  return s.alias ?? (s.name || undefined);
}

/** Sources visible from a scope: its own first, then enclosing levels'. */
export function visibleSources(scope: Scope): { src: Source; depth: number }[] {
  const out: { src: Source; depth: number }[] = [];
  const enclosing = new Set<Scope>();
  for (let s: Scope | undefined = scope; s; s = s.parent) enclosing.add(s);
  let depth = 0;
  for (let s: Scope | undefined = scope; s; s = s.parent, depth++) {
    // A derived table isn't visible inside itself.
    for (const src of s.sources) if (!(src.body && enclosing.has(src.body))) out.push({ src, depth });
  }
  return out;
}

/** CTEs visible from a scope. */
export function visibleCtes(scope: Scope): Cte[] {
  const out: Cte[] = [];
  const seen = new Set<string>();
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const c of s.ctes) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  }
  return out;
}

/** Find the source a qualifier (alias or table name) refers to. */
export function findSource(scope: Scope, qual: string): Source | undefined {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    const src = s.sources.find((x) => x.alias === qual) ?? s.sources.find((x) => !x.alias && x.name === qual);
    if (src) return src;
  }
  return undefined;
}

/** Columns a source provides. */
export function sourceColumns(src: Source, cat: CatalogLike, seen = new Set<Scope>()): Column[] {
  let cols: Column[];
  if (src.kind === 'table') {
    const rel = cat.resolve(src.name, src.schema);
    cols = rel ? relationColumns(rel) : [];
  } else if (src.kind === 'cte') {
    cols = src.cte?.body ? queryColumns(src.cte.body, cat, seen) : [];
    if (src.cte?.columnAliases) cols = applyAliases(cols, src.cte.columnAliases);
  } else if (src.kind === 'subquery' || src.kind === 'values') {
    cols = src.body ? queryColumns(src.body, cat, seen) : [];
  } else {
    // A table function: one column named after the alias (or the function) unless listed.
    cols = src.columnAliases ? [] : [{ name: src.alias ?? src.name, type: '' }];
  }
  if (src.columnAliases) cols = applyAliases(cols, src.columnAliases);
  return cols;
}

function applyAliases(cols: Column[], names: string[]): Column[] {
  const out = names.map((name, i) => (cols[i] ? derived(cols[i], name) : { name, type: '' }));
  return [...out, ...cols.slice(names.length)];
}

/**
 * A column passed through a query level: it keeps its table (for keys and
 * comments) only under its own name, and is no longer a primary key there.
 */
function derived(col: Column, name: string): Column {
  if (col.name !== name) return { name, type: col.type };
  return { ...col, flags: col.flags?.replace('p', '') };
}

export function relationColumns(rel: CatalogRelation): Column[] {
  return rel.columns.map(([name, type, flags, comment]) => ({ name, type, flags: flags ?? undefined, comment: comment ?? undefined, rel }));
}

/** Output columns of a query level. */
export function queryColumns(scope: Scope, cat: CatalogLike, seen = new Set<Scope>()): Column[] {
  if (seen.has(scope)) return [];
  seen.add(scope);
  try {
    if (scope.verb === 'values' && !scope.items.length) return [];
    const out: Column[] = [];
    for (const it of scope.items) {
      if (it.star) {
        const srcs = it.star === true ? scope.sources : [findSource(scope, it.star[it.star.length - 1])].filter((s): s is Source => !!s);
        for (const s of srcs) out.push(...sourceColumns(s, cat, seen));
        continue;
      }
      if (!it.name) {
        out.push({ name: '?column?', type: '' });
        continue;
      }
      const col = it.ref ? resolveColumn(scope, it.ref, cat, seen) : undefined;
      out.push(col ? derived(col, it.name) : { name: it.name, type: '' });
    }
    return out;
  } finally {
    seen.delete(scope);
  }
}

/** Resolve a column reference (col, t.col, s.t.col) within a scope. */
export function resolveColumn(scope: Scope, ref: string[], cat: CatalogLike, seen = new Set<Scope>()): Column | undefined {
  const name = ref[ref.length - 1];
  if (ref.length >= 2) {
    const qual = ref[ref.length - 2];
    const src = findSource(scope, qual);
    if (src) return sourceColumns(src, cat, seen).find((c) => c.name === name);
    const rel = cat.resolve(qual, ref.length >= 3 ? ref[ref.length - 3] : undefined);
    return rel ? relationColumns(rel).find((c) => c.name === name) : undefined;
  }
  for (const { src } of visibleSources(scope)) {
    const c = sourceColumns(src, cat, seen).find((c) => c.name === name);
    if (c) return c;
  }
  return undefined;
}
