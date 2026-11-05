// The schema metadata the server sends, indexed for completions and hover.

import type { Meta, Relation } from './types';

export interface ForeignKeyRef {
  name: string;
  /** The referencing table and its columns. */
  from: Relation;
  columns: string[];
  /** The referenced table and its columns, in the same order. */
  to: Relation;
  refColumns: string[];
}

const key = (schema: string, name: string) => `${schema}\0${name}`;

export class Catalog {
  byName = new Map<string, Relation[]>();
  bySchema = new Map<string, Relation[]>();
  funcsBySchema = new Map<string, Meta['functions']>();
  funcsByName = new Map<string, Meta['functions']>();
  fksFrom = new Map<Relation, ForeignKeyRef[]>();
  fksTo = new Map<Relation, ForeignKeyRef[]>();
  keywords: Set<string>;
  searchPath: string[];

  constructor(public meta: Meta) {
    const byKey = new Map<string, Relation>();
    for (const r of meta.relations) {
      (this.byName.get(r.name) ?? this.byName.set(r.name, []).get(r.name)!).push(r);
      (this.bySchema.get(r.schema) ?? this.bySchema.set(r.schema, []).get(r.schema)!).push(r);
      byKey.set(key(r.schema, r.name), r);
    }
    for (const f of meta.functions) {
      (this.funcsBySchema.get(f.schema) ?? this.funcsBySchema.set(f.schema, []).get(f.schema)!).push(f);
      (this.funcsByName.get(f.name) ?? this.funcsByName.set(f.name, []).get(f.name)!).push(f);
    }
    for (const [schema, table, columns, refSchema, refTable, refColumns, name] of meta.foreign_keys ?? []) {
      const from = byKey.get(key(schema, table));
      const to = byKey.get(key(refSchema, refTable));
      if (!from || !to || !columns || !refColumns) continue;
      const fk: ForeignKeyRef = { name, from, columns, to, refColumns };
      (this.fksFrom.get(from) ?? this.fksFrom.set(from, []).get(from)!).push(fk);
      (this.fksTo.get(to) ?? this.fksTo.set(to, []).get(to)!).push(fk);
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

  /** The foreign key a column takes part in (the first, if several). */
  columnFk(r: Relation, column: string): ForeignKeyRef | undefined {
    return this.fksFrom.get(r)?.find((fk) => fk.columns.includes(column));
  }

  /** Functions with this name, from the search path or a given schema. */
  functions(name: string, schema?: string): Meta['functions'] {
    const all = this.funcsByName.get(name) ?? [];
    if (schema) return all.filter((f) => f.schema === schema);
    for (const s of this.searchPath) {
      const fs = all.filter((f) => f.schema === s);
      if (fs.length) return fs;
    }
    return [];
  }
}
