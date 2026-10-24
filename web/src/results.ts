import { type Accessor, createSignal } from 'solid-js';
import { api } from './api';
import type { Column, Row, RowsItem } from './types';

const CHUNK = 1000;

/** Rows of one result, loaded lazily from the server in chunks. */
export interface ResultData {
  id: string;
  columns: Column[];
  readonly stored: number;
  rowCount: number;
  rows: (Row | undefined)[];
  version: Accessor<number>;
  ensure(start: number, end: number): Promise<void>;
  /** All rows in [start, end), loading as needed. */
  slice(start: number, end: number): Promise<Row[]>;
  missing: Accessor<boolean>;
}

const cache = new Map<string, ResultData>();

export function resultData(item: RowsItem): ResultData {
  const hit = cache.get(item.result_id);
  if (hit) return hit;
  const [version, setVersion] = createSignal(0);
  const [missing, setMissing] = createSignal(false);
  const [stored, setStored] = createSignal(item.stored);
  const rows: (Row | undefined)[] = new Array(item.stored);
  item.rows.forEach((r, i) => (rows[i] = r));
  const inflight = new Map<number, Promise<void>>();
  const loadChunk = (chunk: number): Promise<void> => {
    const existing = inflight.get(chunk);
    if (existing) return existing;
    const p = api
      .rows(item.result_id, chunk * CHUNK, CHUNK)
      .then((res) => {
        res.rows.forEach((r, i) => (rows[res.offset + i] = r));
        if (res.available < item.stored) {
          // Only a prefix survived a restart; shrink to what's available.
          rows.length = res.available;
          setStored(res.available);
          setMissing(true);
        }
        setVersion((v) => v + 1);
      })
      .catch(() => {
        setMissing(true);
        inflight.delete(chunk);
      });
    inflight.set(chunk, p);
    return p;
  };
  const data: ResultData = {
    id: item.result_id,
    columns: item.columns,
    get stored() {
      return stored();
    },
    rowCount: item.row_count,
    rows,
    version,
    missing,
    async ensure(start, end) {
      end = Math.min(end, data.stored);
      const waits: Promise<void>[] = [];
      for (let c = Math.floor(start / CHUNK); c * CHUNK < end; c++) {
        let need = false;
        for (let i = Math.max(c * CHUNK, start); i < Math.min((c + 1) * CHUNK, end); i++) {
          if (!rows[i]) {
            need = true;
            break;
          }
        }
        if (need) waits.push(loadChunk(c));
      }
      await Promise.all(waits);
    },
    async slice(start, end) {
      await data.ensure(start, end);
      const out: Row[] = [];
      for (let i = start; i < Math.min(end, data.stored); i++) if (rows[i]) out.push(rows[i]!);
      return out;
    },
  };
  cache.set(item.result_id, data);
  return data;
}
