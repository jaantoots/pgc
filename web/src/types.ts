export type Cell = string | null;
export type Row = Cell[];

export interface Column {
  name: string;
  type_oid: number;
  type_name: string;
  numeric: boolean;
}

export interface DbError {
  severity: string;
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: number;
  internal_position?: number;
  internal_query?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

export interface RowsItem {
  kind: 'rows';
  result_id: string;
  columns: Column[];
  rows: Row[];
  row_count: number;
  stored: number;
  tag?: string;
  title?: string;
  footer?: string[];
  expanded: boolean;
}

export type Item =
  | RowsItem
  | { kind: 'command'; tag: string }
  | { kind: 'notice'; notice: DbError }
  | { kind: 'error'; error: DbError; offset?: number }
  | { kind: 'text'; text: string }
  | { kind: 'notification'; pid: number; channel: string; payload: string };

export interface Entry {
  id: string;
  session_id: string;
  seq: number;
  sql: string;
  status: 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted';
  started_at: number;
  duration_ms: number | null;
  items: Item[];
  conn_label: string;
  runs: number;
}

export type TxStatus = 'idle' | 'transaction' | 'failed';

export interface ConnState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'need_password';
  conninfo: string;
  label: string | null;
  dbname: string | null;
  user: string | null;
  host: string | null;
  port: number | null;
  unix_socket: boolean;
  tls: string | null;
  server_version: string | null;
  tx: TxStatus | null;
  superuser: boolean;
  pid: number | null;
  error: string | null;
}

export interface Settings {
  expanded: 'on' | 'off' | 'auto';
}

export interface SessionInfo {
  id: string;
  name: string | null;
  conninfo: string;
  conn_label: string | null;
  created_at: number;
  updated_at: number;
  settings: Settings;
  entry_count: number;
  last_sql: string | null;
  active?: boolean;
  viewers?: number;
}

export interface HistoryRow {
  id: number;
  session_id: string;
  entry_id: string | null;
  sql: string;
  executed_at: number;
  duration_ms: number | null;
  status: string;
  conn_label: string;
}

export interface Relation {
  schema: string;
  name: string;
  kind: string;
  columns: [string, string][];
}

export interface Meta {
  relations: Relation[];
  functions: { schema: string; name: string; kind: string; args: string }[];
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
