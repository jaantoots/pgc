// Small DOM views of schema objects, shared by hover tooltips and the
// completion info panel.

import type { Catalog } from './catalog';
import type { Column } from './scope';
import { quoteIdent } from './sqlscan';
import type { Meta, Relation } from './types';

export const kindLabel: Record<string, string> = {
  r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table', S: 'sequence',
};

const MAX_COLUMNS = 40;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function qualifiedName(cat: Catalog, r: Relation): string {
  return cat.visible(r) ? quoteIdent(r.name) : `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`;
}

function fkTarget(cat: Catalog, r: Relation, col: string): string | undefined {
  const fk = cat.columnFk(r, col);
  if (!fk) return undefined;
  const i = fk.columns.indexOf(col);
  return `${qualifiedName(cat, fk.to)}.${quoteIdent(fk.refColumns[i])}`;
}

/** A muted line of text, e.g. which foreign key a join follows. */
export function noteLine(text: string): HTMLElement {
  return el('div', 'pgc-schema-more', text);
}

function head(kind: string, name: string, extra?: string): HTMLElement {
  const h = el('div', 'pgc-schema-head');
  h.append(el('span', 'pgc-schema-kind', kind), el('span', 'pgc-schema-name', name));
  if (extra) h.append(el('span', 'pgc-schema-type', extra));
  return h;
}

function columnsTable(cat: Catalog, cols: Column[]): HTMLElement {
  const wrap = el('div');
  const table = el('table', 'pgc-schema-cols');
  for (const c of cols.slice(0, MAX_COLUMNS)) {
    const tr = el('tr');
    const name = el('td', 'pgc-schema-col', quoteIdent(c.name));
    if (c.flags?.includes('p')) name.append(el('span', 'pgc-schema-badge', 'PK'));
    const notes: string[] = [];
    if (c.flags?.includes('n') && !c.flags.includes('p')) notes.push('not null');
    const ref = c.rel ? fkTarget(cat, c.rel, c.name) : undefined;
    if (ref) notes.push(`→ ${ref}`);
    tr.append(name, el('td', 'pgc-schema-type', c.type), el('td', 'pgc-schema-note', notes.join(' ')));
    if (c.comment) tr.title = c.comment;
    table.append(tr);
  }
  wrap.append(table);
  if (cols.length > MAX_COLUMNS) wrap.append(el('div', 'pgc-schema-more', `… ${cols.length - MAX_COLUMNS} more columns`));
  if (!cols.length) wrap.append(el('div', 'pgc-schema-more', 'no columns'));
  return wrap;
}

function relationCols(r: Relation): Column[] {
  return r.columns.map(([name, type, flags, comment]) => ({ name, type, flags: flags ?? undefined, comment: comment ?? undefined, rel: r }));
}

/** A table, view, … with its columns, keys and comment. */
export function relationView(cat: Catalog, r: Relation, alias?: string): HTMLElement {
  const root = el('div', 'pgc-schema');
  const name = `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`;
  root.append(head(kindLabel[r.kind] ?? r.kind, name, alias && alias !== r.name ? `as ${quoteIdent(alias)}` : undefined));
  if (r.comment) root.append(el('div', 'pgc-schema-comment', r.comment));
  if (r.kind !== 'S') root.append(columnsTable(cat, relationCols(r)));
  const refs = cat.fksTo.get(r) ?? [];
  if (refs.length) {
    const names = [...new Set(refs.map((fk) => qualifiedName(cat, fk.from)))];
    root.append(el('div', 'pgc-schema-refs', `Referenced by: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`));
  }
  return root;
}

/** A CTE, derived table or table function, with the columns it provides. */
export function derivedView(cat: Catalog, kind: string, name: string, cols: Column[]): HTMLElement {
  const root = el('div', 'pgc-schema');
  root.append(head(kind, name));
  root.append(columnsTable(cat, cols));
  return root;
}

/** One column: its type, constraints, foreign key and comment. */
export function columnView(cat: Catalog, c: Column, owner?: string): HTMLElement {
  const root = el('div', 'pgc-schema');
  const ownerName = owner ?? (c.rel ? qualifiedName(cat, c.rel) : undefined);
  root.append(head('column', ownerName ? `${ownerName}.${quoteIdent(c.name)}` : quoteIdent(c.name), c.type || undefined));
  const notes: string[] = [];
  if (c.flags?.includes('p')) notes.push('primary key');
  if (c.flags?.includes('n')) notes.push('not null');
  if (c.flags?.includes('d')) notes.push('has default');
  const ref = c.rel ? fkTarget(cat, c.rel, c.name) : undefined;
  if (ref) notes.push(`references ${ref}`);
  if (notes.length) root.append(el('div', 'pgc-schema-note', notes.join(' · ')));
  if (c.comment) root.append(el('div', 'pgc-schema-comment', c.comment));
  return root;
}

const funcKind: Record<string, string> = { a: 'aggregate', w: 'window function', p: 'procedure', f: 'function' };

export function functionView(fs: Meta['functions']): HTMLElement {
  const root = el('div', 'pgc-schema');
  for (const f of fs.slice(0, 5)) {
    root.append(head(funcKind[f.kind] ?? 'function', `${quoteIdent(f.schema)}.${quoteIdent(f.name)}(${f.args})`));
    const more = (f.overloads ?? 1) - 1;
    if (more > 0) root.append(el('div', 'pgc-schema-more', `+ ${more} more overload${more > 1 ? 's' : ''}`));
  }
  return root;
}
