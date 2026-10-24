import { createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { Catalog } from './completion';
import type { ConnState, Entry, Item, Meta, SessionInfo, Settings } from './types';

export interface SessionState {
  session: SessionInfo | null;
  entries: Entry[];
  conn: ConnState | null;
  running: string | null;
  settings: Settings;
  progress: Record<string, number>;
  socket: 'connecting' | 'open' | 'closed';
  fatal: string | null;
}

export type ClientMsg =
  | { type: 'run'; sql: string; entry_id?: string }
  | { type: 'cancel' }
  | { type: 'password'; password: string }
  | { type: 'connect'; conninfo?: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'refresh_meta' };

export function createSession(id: string) {
  const [state, setState] = createStore<SessionState>({
    session: null,
    entries: [],
    conn: null,
    running: null,
    settings: { expanded: 'off' },
    progress: {},
    socket: 'connecting',
    fatal: null,
  });
  // The catalog is large and read-only; keep it out of the reactive store.
  const [catalog, setCatalog] = createSignal<Catalog | null>(null, { equals: false });
  const listeners = new Set<(e: { type: string; [k: string]: unknown }) => void>();

  let ws: WebSocket | null = null;
  let retry = 0;
  let closed = false;
  const queue: ClientMsg[] = [];

  const upsert = (e: Entry) =>
    setState(
      produce((s) => {
        const i = s.entries.findIndex((x) => x.id === e.id);
        if (i >= 0) s.entries[i] = e;
        else {
          s.entries.push(e);
          s.entries.sort((a, b) => a.seq - b.seq);
        }
        if (e.status !== 'running') delete s.progress[e.id];
      }),
    );

  const onMessage = (m: MessageEvent) => {
    const d = JSON.parse(m.data);
    switch (d.type) {
      case 'snapshot':
        setState({ session: d.session, conn: d.conn, running: d.running, settings: d.settings, fatal: null });
        setState('entries', reconcile(d.entries as Entry[], { key: 'id' }));
        break;
      case 'entry':
        upsert(d.entry);
        setState('running', d.entry.status === 'running' ? d.entry.id : state.running === d.entry.id ? null : state.running);
        break;
      case 'item': {
        const i = state.entries.findIndex((x) => x.id === d.entry_id);
        if (i >= 0) setState('entries', i, 'items', d.index as number, d.item as Item);
        break;
      }
      case 'entry_removed':
        setState('entries', (es) => es.filter((e) => e.id !== d.id));
        break;
      case 'progress':
        setState('progress', d.entry_id, d.rows);
        break;
      case 'conn':
        setState('conn', reconcile(d.conn as ConnState));
        break;
      case 'meta':
        setCatalog(new Catalog(d.meta as Meta));
        break;
      case 'settings':
        setState('settings', d.settings);
        break;
      case 'renamed':
        if (state.session) setState('session', 'name', d.name);
        break;
      case 'fatal':
        setState('fatal', d.error);
        break;
    }
    for (const l of listeners) l(d);
  };

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/${id}`);
    setState('socket', 'connecting');
    ws.onopen = () => {
      retry = 0;
      setState('socket', 'open');
      while (queue.length) ws!.send(JSON.stringify(queue.shift()));
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      setState('socket', 'closed');
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 250 * 2 ** retry);
    };
  };
  connect();

  return {
    id,
    state,
    setState,
    catalog,
    send(msg: ClientMsg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    },
    on(l: (e: { type: string; [k: string]: unknown }) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}

export type Session = ReturnType<typeof createSession>;
