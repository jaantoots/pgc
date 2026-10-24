import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { EditorView } from '@codemirror/view';
import { api } from './api';
import { createEditor, setDoc } from './editor';
import EntryView, { isBig } from './EntryView';
import { relTime } from './format';
import { createSession } from './session';
import type { SessionInfo } from './types';
import { ContextMenu, Modal, modKey, toast, Toasts } from './ui';

export default function SessionView(props: { id: string }) {
  const s = createSession(props.id);
  onCleanup(() => s.close());
  const st = s.state;

  const [explicit, setExplicit] = createStore<Record<string, boolean>>({});
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [showSessions, setShowSessions] = createSignal(false);
  const [showHistory, setShowHistory] = createSignal(false);
  const [showConnect, setShowConnect] = createSignal(false);
  const [editingName, setEditingName] = createSignal(false);

  const visibleEntries = () => st.entries;
  const latestId = createMemo(() => {
    for (let i = st.entries.length - 1; i >= 0; i--) if (st.entries[i].sql) return st.entries[i].id;
    return null;
  });
  const collapsed = (id: string) => {
    const e = st.entries.find((x) => x.id === id);
    if (!e) return false;
    return explicit[id] ?? (id !== latestId() && e.status !== 'running' && isBig(e));
  };

  const prompt = createMemo(() => {
    const c = st.conn;
    if (!c || c.status !== 'connected') return c?.status === 'connecting' ? '…' : '!>';
    const tx = c.tx === 'transaction' ? '*' : c.tx === 'failed' ? '!' : '';
    return `${c.dbname}=${tx}${c.superuser ? '#' : '>'}`;
  });

  createEffect(() => {
    const name = st.session?.name || st.conn?.dbname || 'pgc';
    document.title = `${name} — pgc`;
  });

  // ---- bottom editor & history navigation ----
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let hist: string[] = [];
  let histIdx = -1;
  let draft = '';
  const loadHistory = () =>
    api
      .history('', 1000)
      .then((h) => (hist = h.map((x) => x.sql)))
      .catch(() => {});
  const run = (sql: string, entryId?: string) => {
    if (st.running) {
      toast('A query is already running — cancel it first (Esc)', 'error');
      return false;
    }
    s.send({ type: 'run', sql, entry_id: entryId });
    if (hist[0] !== sql) hist.unshift(sql);
    histIdx = -1;
    draft = '';
    stickToBottom = true;
    return true;
  };
  onMount(() => {
    void loadHistory();
    view = createEditor({
      parent: host,
      placeholder: 'Type SQL or \\? for help · Enter runs a statement ending in ; · Shift+Enter for a new line',
      catalog: s.catalog,
      autofocus: true,
      onRun: (sql) => {
        if (run(sql)) setDoc(view!, '');
      },
      onEscape: () => {
        if (st.running) {
          s.send({ type: 'cancel' });
          toast('Cancel requested');
          return true;
        }
        return false;
      },
      onHistory: (dir, current) => {
        if (!hist.length) return null;
        if (histIdx === -1) {
          if (dir === 1) return null;
          draft = current;
        }
        const next = histIdx - dir;
        if (next < -1 || next >= hist.length) return null;
        histIdx = next;
        return histIdx === -1 ? draft : hist[histIdx];
      },
      onHistorySearch: () => setShowHistory(true),
    });
  });
  onCleanup(() => view?.destroy());

  const insertIntoEditor = (sql: string) => {
    if (!view) return;
    setDoc(view, sql);
    view.focus();
  };

  // ---- scrolling: follow output while at the bottom ----
  let stickToBottom = true;
  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  const onScroll = () => (stickToBottom = nearBottom());
  onMount(() => window.addEventListener('scroll', onScroll, { passive: true }));
  onCleanup(() => window.removeEventListener('scroll', onScroll));
  createEffect(
    on(
      () => [st.entries.length, st.entries[st.entries.length - 1]?.items.length, st.entries[st.entries.length - 1]?.status],
      () => {
        if (stickToBottom && !editingId()) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
      },
    ),
  );

  // ---- global shortcuts ----
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      setShowHistory(true);
    } else if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      setShowSessions(true);
    } else if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      view?.focus();
    }
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  const rename = async (name: string) => {
    setEditingName(false);
    try {
      await api.renameSession(props.id, name || null);
      s.setState('session', 'name', name || null);
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const connClass = () => {
    const c = st.conn;
    if (!c) return 'off';
    if (c.status !== 'connected') return c.status === 'connecting' ? 'pending' : 'off';
    return c.tx === 'failed' ? 'failed' : c.tx === 'transaction' ? 'tx' : 'ok';
  };
  const connTitle = () => {
    const c = st.conn;
    if (!c) return '';
    const parts: string[] = [c.status];
    if (c.server_version) parts.push(`PostgreSQL ${c.server_version.split(' ')[0]}`);
    if (c.tls) parts.push(c.tls);
    if (c.pid) parts.push(`pid ${c.pid}`);
    if (c.tx === 'transaction') parts.push('in transaction');
    if (c.tx === 'failed') parts.push('transaction failed — ROLLBACK to continue');
    return parts.join(' · ');
  };

  return (
    <div class="app" onClick={(e) => e.target === e.currentTarget && view?.focus()}>
      <header class="topbar">
        <a class="logo" href="/" title="New session">
          pgc
        </a>
        <Show
          when={editingName()}
          fallback={
            <button class="session-name" title="Rename session" onClick={() => setEditingName(true)}>
              {st.session?.name || <span class="muted">untitled session</span>}
            </button>
          }
        >
          <input
            class="session-name-input"
            value={st.session?.name ?? ''}
            ref={(el) => setTimeout(() => el.select())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename(e.currentTarget.value.trim());
              if (e.key === 'Escape') setEditingName(false);
            }}
            onBlur={(e) => void rename(e.currentTarget.value.trim())}
          />
        </Show>
        <button class="conn" title={connTitle()} onClick={() => setShowConnect(true)}>
          <span class={`dot ${connClass()}`} />
          {st.conn?.label ?? st.conn?.conninfo ?? '…'}
          <Show when={st.conn?.tx === 'transaction'}>
            <span class="badge tx">in transaction</span>
          </Show>
          <Show when={st.conn?.tx === 'failed'}>
            <span class="badge failed">transaction failed</span>
          </Show>
        </button>
        <span class="spacer" />
        <Show when={st.socket !== 'open'}>
          <span class="badge failed">{st.socket === 'connecting' ? 'connecting to pgc…' : 'pgc server unreachable'}</span>
        </Show>
        <label class="xsel" title="Expanded display (\x)">
          \x
          <select value={st.settings.expanded} onChange={(e) => s.send({ type: 'settings', settings: { ...st.settings, expanded: e.currentTarget.value as 'on' } })}>
            <option value="off">off</option>
            <option value="on">on</option>
            <option value="auto">auto</option>
          </select>
        </label>
        <button class="btn ghost" onClick={() => setShowHistory(true)} title={`Search history (${modKey}R)`}>
          History
        </button>
        <button class="btn ghost" onClick={() => setShowSessions(true)} title={`Switch session (${modKey}O)`}>
          Sessions
        </button>
        <a class="btn ghost" href="/" title="Start a new session in this tab (Ctrl/⌘-click for a new tab)">
          New
        </a>
      </header>

      <Show when={st.fatal}>
        <div class="banner error">
          {st.fatal} — <a href="/">start a new session</a>
        </div>
      </Show>

      <main class="transcript">
        <For each={visibleEntries()}>
          {(e) => (
            <EntryView
              entry={e}
              session={s}
              latest={e.id === latestId()}
              collapsed={collapsed(e.id)}
              setCollapsed={(c) => setExplicit(e.id, c)}
              editing={editingId() === e.id}
              setEditing={(on) => {
                setEditingId(on ? e.id : null);
                if (on) setExplicit(e.id, false);
                if (!on) view?.focus();
              }}
              onCopyToEditor={insertIntoEditor}
            />
          )}
        </For>
      </main>

      <div class="composer">
        <Show when={st.conn?.status === 'need_password'}>
          <PasswordBar session={s} />
        </Show>
        <Show when={(st.conn?.status === 'error' || st.conn?.status === 'disconnected') && st.conn?.error}>
          <div class="conn-error">
            <pre>{st.conn!.error}</pre>
            <div class="row">
              <button class="btn small" onClick={() => s.send({ type: 'connect' })}>
                Retry
              </button>
              <button class="btn small ghost" onClick={() => setShowConnect(true)}>
                Change connection…
              </button>
            </div>
          </div>
        </Show>
        <div class="editor-row" classList={{ running: !!st.running }}>
          <div class="prompt" title={connTitle()}>
            {prompt()}
          </div>
          <div class="editor-host main-editor" ref={host} />
          <div class="editor-actions">
            <Show
              when={st.running}
              fallback={
                <button class="btn primary" title={`Run (${modKey}Enter)`} onClick={() => view && view.state.doc.length && run(view.state.doc.toString()) && setDoc(view, '')}>
                  Run
                </button>
              }
            >
              <button class="btn danger" title="Cancel (Esc)" onClick={() => s.send({ type: 'cancel' })}>
                Cancel
              </button>
            </Show>
          </div>
        </div>
      </div>

      <Show when={st.entries.length === 0 && st.session !== null}>
        <Welcome session={s.id} onConnect={() => setShowConnect(true)} conninfo={st.conn?.label ?? st.conn?.conninfo ?? ''} />
      </Show>

      <Show when={showSessions()}>
        <SessionPicker current={props.id} onClose={() => setShowSessions(false)} />
      </Show>
      <Show when={showHistory()}>
        <HistorySearch
          sessionId={props.id}
          onClose={() => {
            setShowHistory(false);
            view?.focus();
          }}
          onPick={(sql, runNow) => {
            setShowHistory(false);
            if (runNow) run(sql);
            else insertIntoEditor(sql);
          }}
        />
      </Show>
      <Show when={showConnect()}>
        <ConnectDialog
          current={st.conn?.conninfo ?? ''}
          onClose={() => setShowConnect(false)}
          onConnect={(conninfo) => {
            setShowConnect(false);
            s.send({ type: 'connect', conninfo });
          }}
        />
      </Show>
      <ContextMenu />
      <Toasts />
    </div>
  );
}

function PasswordBar(props: { session: ReturnType<typeof createSession> }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const c = () => props.session.state.conn!;
  const submit = (e: Event) => {
    e.preventDefault();
    props.session.send({ type: 'password', password: input.value });
    input.value = '';
  };
  return (
    <form class="password-bar" onSubmit={submit}>
      <Show when={c().error}>
        <div class="err small">{c().error}</div>
      </Show>
      <label>
        Password for <code>{c().conninfo}</code>
        <input ref={input} type="password" autocomplete="current-password" placeholder="password" />
      </label>
      <button class="btn primary small" type="submit">
        Connect
      </button>
      <span class="muted small">kept in memory only — use ~/.pgpass to avoid typing it</span>
    </form>
  );
}

function Welcome(props: { session: string; conninfo: string; onConnect: () => void }) {
  const [sessions] = createResource(() => api.sessions());
  const others = () => (sessions() ?? []).filter((s) => s.id !== props.session).slice(0, 12);
  return (
    <div class="welcome">
      <div class="welcome-section">
        <h3>New session</h3>
        <p class="muted">
          Connected with <code>{props.conninfo || 'defaults'}</code> ·{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), props.onConnect())}>
            change
          </a>
        </p>
        <p class="muted small">
          Enter runs when the statement ends with <code>;</code> · {modKey}Enter always runs · ↑/↓ walk history · {modKey}R searches it · click a
          previous query to edit and re-run it in place.
        </p>
      </div>
      <Show when={others().length}>
        <div class="welcome-section">
          <h3>Or resume a session</h3>
          <SessionList sessions={others()} current={props.session} />
        </div>
      </Show>
    </div>
  );
}

function SessionList(props: { sessions: SessionInfo[]; current: string; onDelete?: (id: string) => void }) {
  return (
    <div class="session-list">
      <For each={props.sessions}>
        {(s) => (
          <a class="session-item" href={`/s/${s.id}`} classList={{ current: s.id === props.current }}>
            <div class="si-main">
              <span class="si-name">{s.name || <span class="muted">untitled</span>}</span>
              <span class="si-sql">{s.last_sql?.replace(/\s+/g, ' ').slice(0, 140)}</span>
            </div>
            <div class="si-meta">
              <span>{s.conn_label ?? s.conninfo}</span>
              <span>
                {s.entry_count} {s.entry_count === 1 ? 'entry' : 'entries'}
              </span>
              <span>{relTime(s.updated_at)}</span>
              <Show when={(s.viewers ?? 0) > 0}>
                <span class="badge ok">open</span>
              </Show>
              <Show when={props.onDelete && s.id !== props.current}>
                <button
                  class="icon-btn small"
                  title="Delete session"
                  onClick={(e) => {
                    e.preventDefault();
                    props.onDelete!(s.id);
                  }}
                >
                  🗑
                </button>
              </Show>
            </div>
          </a>
        )}
      </For>
    </div>
  );
}

function SessionPicker(props: { current: string; onClose: () => void }) {
  const [sessions, { refetch }] = createResource(() => api.sessions());
  const [q, setQ] = createSignal('');
  const filtered = () => {
    const needle = q().toLowerCase();
    return (sessions() ?? []).filter((s) => !needle || [s.name, s.last_sql, s.conn_label, s.conninfo].some((x) => x?.toLowerCase().includes(needle)));
  };
  const del = async (id: string) => {
    if (!confirm('Delete this session and its saved results? Its queries stay in history.')) return;
    await api.deleteSession(id);
    void refetch();
  };
  return (
    <Modal title="Sessions" onClose={props.onClose} wide>
      <div class="picker">
        <div class="row">
          <input class="search" placeholder="Filter sessions…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} ref={(el) => setTimeout(() => el.focus())} />
          <a class="btn primary" href="/">
            New session
          </a>
        </div>
        <SessionList sessions={filtered()} current={props.current} onDelete={del} />
        <Show when={sessions() && !filtered().length}>
          <div class="muted">No sessions.</div>
        </Show>
      </div>
    </Modal>
  );
}

function HistorySearch(props: { sessionId: string; onClose: () => void; onPick: (sql: string, run: boolean) => void }) {
  const [q, setQ] = createSignal('');
  const [thisOnly, setThisOnly] = createSignal(false);
  const [sel, setSel] = createSignal(0);
  const [debounced, setDebounced] = createSignal('');
  let t: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const v = q();
    clearTimeout(t);
    t = setTimeout(() => setDebounced(v), 120);
  });
  const [rows] = createResource(
    () => [debounced(), thisOnly()] as const,
    ([q, only]) => api.history(q, 300, only ? props.sessionId : undefined),
  );
  createEffect(on(rows, () => setSel(0)));
  let list!: HTMLDivElement;
  const onKey = (e: KeyboardEvent) => {
    const n = rows()?.length ?? 0;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setSel((s) => Math.min(n - 1, s + 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (e.ctrlKey && e.key === 'r')) {
      e.preventDefault();
      setSel((s) => (e.key === 'r' ? Math.min(n - 1, s + 1) : Math.max(0, s - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows()?.[sel()];
      if (r) props.onPick(r.sql, e.ctrlKey || e.metaKey);
    }
    queueMicrotask(() => list?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }));
  };
  return (
    <Modal title="History" onClose={props.onClose} wide>
      <div class="picker">
        <div class="row">
          <input class="search" placeholder="Search all queries…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} ref={(el) => setTimeout(() => el.focus())} />
          <label class="small">
            <input type="checkbox" checked={thisOnly()} onChange={(e) => setThisOnly(e.currentTarget.checked)} /> this session
          </label>
        </div>
        <div class="history-list" ref={list}>
          <For each={rows() ?? []}>
            {(r, i) => (
              <div class="history-item" classList={{ sel: i() === sel(), error: r.status === 'error' }} onMouseEnter={() => setSel(i())} onClick={(e) => props.onPick(r.sql, e.ctrlKey || e.metaKey)}>
                <pre>{r.sql}</pre>
                <div class="si-meta">
                  <span>{r.conn_label}</span>
                  <span>{relTime(r.executed_at)}</span>
                  <Show when={r.status !== 'ok'}>
                    <span class={`badge ${r.status === 'error' ? 'failed' : ''}`}>{r.status}</span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="muted small">Enter puts the query in the editor · {modKey}Enter runs it · Esc closes</div>
      </div>
    </Modal>
  );
}

function ConnectDialog(props: { current: string; onClose: () => void; onConnect: (conninfo: string) => void }) {
  const [value, setValue] = createSignal(props.current);
  const [services] = createResource(() => api.services());
  return (
    <Modal title="Connection" onClose={props.onClose} wide>
      <form
        class="picker"
        onSubmit={(e) => {
          e.preventDefault();
          props.onConnect(value());
        }}
      >
        <label class="small muted">Connection string (key=value or postgresql:// URI). Unset values come from PG* variables, pg_service.conf and defaults.</label>
        <div class="row">
          <input class="search mono" value={value()} onInput={(e) => setValue(e.currentTarget.value)} ref={(el) => setTimeout(() => el.focus())} />
          <button class="btn primary" type="submit">
            Connect
          </button>
        </div>
        <Show when={services()?.length}>
          <div class="small muted">Services</div>
          <div class="service-list">
            <For each={services()}>
              {(sv) => (
                <button type="button" class="service" onClick={() => props.onConnect(`service=${sv.name}`)} title={sv.file}>
                  <b>{sv.name}</b>
                  <span class="muted">{Object.entries(sv.params).map(([k, v]) => `${k}=${v}`).join(' ')}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </form>
    </Modal>
  );
}
