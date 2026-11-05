// Types shared with the backend are generated from the Rust definitions by
// ts-rs into ./bindings (`make bindings`); the rest are built ad hoc with json!.
import type { Item } from './bindings/Item';
import type { SessionRow } from './bindings/SessionRow';

export type { ClientMsg } from './bindings/ClientMsg';
export type { Column } from './bindings/Column';
export type { ConnState } from './bindings/ConnState';
export type { ConnStatus } from './bindings/ConnStatus';
export type { DbError } from './bindings/DbError';
export type { Entry } from './bindings/Entry';
export type { EntryStatus } from './bindings/EntryStatus';
export type { Expanded } from './bindings/Expanded';
export type { HistoryRow } from './bindings/HistoryRow';
export type { Item } from './bindings/Item';
export type { Settings } from './bindings/Settings';
export type { TxStatus } from './bindings/TxStatus';

export type Cell = string | null;
export type Row = Cell[];

export type RowsItem = Extract<Item, { kind: 'rows' }>;

/** A saved session as listed by /api/sessions, with whether it is open and by how many tabs. */
export type SessionInfo = SessionRow & { active?: boolean; viewers?: number };

/** [name, type, flags, comment]; flags: n = not null, p = primary key, d = has a default. */
export type ColumnInfo = [string, string, string?, (string | null)?];

export interface Relation {
  schema: string;
  name: string;
  kind: string;
  comment?: string | null;
  columns: ColumnInfo[];
}

/** [schema, table, columns, referenced schema, referenced table, referenced columns, constraint name] */
export type ForeignKey = [string, string, string[], string, string, string[], string];

export interface Meta {
  relations: Relation[];
  foreign_keys?: ForeignKey[];
  functions: { schema: string; name: string; kind: string; args: string; overloads?: number }[];
  search_path: string[];
  schemas: string[];
  databases: string[];
  roles: string[];
  types: [string, string][];
  keywords: [string, string][];
}

export interface Service {
  name: string;
  params: Record<string, string>;
  file: string;
}
