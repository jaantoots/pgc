import { createMemo, createResource, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { EditorView } from '@codemirror/view';
import { api } from './api';
import { createEditor } from './editor';
import { copyText, displayValue, formatDuration, formatRows, plural, prettyValue } from './format';
import { highlightSql } from './highlight';
import ResultGrid from './ResultGrid';
import { resultData, type ResultData } from './results';
import type { Session } from './session';
import type { DbError, Entry, Item, RowsItem } from './types';
import { Modal, modKey, openMenu, toast } from './ui';

/** Code-point offset -> UTF-16 index. */
function cpToIndex(s: string, cp: number): number {
  let i = 0;
  let n = 0;
  for (const ch of s) {
    if (n === cp) return i;
    i += ch.length;
    n++;
  }
  return s.length;
}

export function errorMark(entry: Entry): number | undefined {
  for (const it of entry.items) {
    if (it.kind === 'error' && it.offset !== undefined && it.offset < 1e15 && it.error.position) {
      return cpToIndex(entry.sql, it.offset + it.error.position - 1);
    }
  }
  return undefined;
}

export function isBig(entry: Entry): boolean {
  let rows = 0;
  for (const it of entry.items) {
    if (it.kind === 'rows') rows += Math.max(it.stored, 1) + 2;
    if (it.kind === 'text') rows += it.text.split('\n').length;
  }
  return rows > 14;
}

export interface EntryProps {
  entry: Entry;
  session: Session;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
  editing: boolean;
  setEditing: (e: boolean) => void;
  onCopyToEditor: (sql: string) => void;
  latest: boolean;
}

export default function EntryView(props: EntryProps) {
  const e = () => props.entry;
  const running = () => e().status === 'running';
  const mark = createMemo(() => errorMark(e()));
  const html = createMemo(() => highlightSql(e().sql, mark()));
  const rowsItems = () => e().items.filter((i): i is RowsItem => i.kind === 'rows');
  const system = () => e().sql === '';

  const summary = createMemo(() => {
    const parts: string[] = [];
    for (const it of e().items) {
      if (it.kind === 'rows') parts.push(`${it.title ? it.title + ': ' : ''}${plural(it.row_count, 'row')} × ${plural(it.columns.length, 'col')}`);
      else if (it.kind === 'command') parts.push(it.tag);
      else if (it.kind === 'error') parts.push(`${it.error.severity}: ${it.error.message}`);
    }
    return parts.join(' · ');
  });

  const menu = (ev: MouseEvent) =>
    openMenu(ev, [
      { label: 'Edit and re-run here', hint: 'click query', action: () => props.setEditing(true) },
      { label: 'Re-run', action: () => props.session.send({ type: 'run', sql: e().sql, entry_id: e().id }), disabled: !!props.session.state.running },
      { label: 'Copy to editor', action: () => props.onCopyToEditor(e().sql) },
      { label: 'Copy SQL', action: () => copyText(e().sql).then(() => toast('Copied SQL')) },
      { separator: true, label: '' },
      { label: props.collapsed ? 'Expand' : 'Collapse', action: () => props.setCollapsed(!props.collapsed) },
      {
        label: 'Remove from view',
        hint: 'stays in history',
        action: () => api.hideEntry(e().id).catch((err) => toast(String(err), 'error')),
        disabled: running(),
      },
    ]);

  return (
    <div class="entry" classList={{ running: running(), error: e().status === 'error', collapsed: props.collapsed, system: system() }} data-entry={e().id}>
      <Show when={!system()}>
        <div class="entry-head">
          <div class="entry-gutter">
            <span class="status-dot" classList={{ [e().status]: true }} title={e().status} />
          </div>
          <Show
            when={props.editing}
            fallback={
              <pre
                class="entry-sql"
                title="Click to edit and re-run in place"
                onClick={() => {
                  if (!window.getSelection()?.toString()) props.setEditing(true);
                }}
                innerHTML={html()}
              />
            }
          >
            <InlineEditor entry={e()} session={props.session} onDone={() => props.setEditing(false)} />
          </Show>
          <div class="entry-meta">
            <Show when={running()}>
              <span class="spinner" />
              <Show when={props.session.state.progress[e().id]}>
                <span class="muted">{plural(props.session.state.progress[e().id], 'row')}…</span>
              </Show>
              <button class="btn small danger" onClick={() => props.session.send({ type: 'cancel' })} title="Cancel query (Esc in editor)">
                Cancel
              </button>
            </Show>
            <Show when={!running()}>
              <span class="muted" title={new Date(e().started_at).toLocaleString()}>
                {formatDuration(e().duration_ms)}
              </span>
              <Show when={e().runs > 1}>
                <span class="muted" title="Times run">
                  ×{e().runs}
                </span>
              </Show>
            </Show>
            <button class="icon-btn" title="Entry actions" onClick={menu}>
              ⋯
            </button>
          </div>
        </div>
      </Show>
      <Show
        when={!props.collapsed}
        fallback={
          <button class="collapsed-summary" onClick={() => props.setCollapsed(false)}>
            <span class="chev">▸</span> {summary()}
            <Show when={rowsItems()[0]}>{(it) => <span class="muted cols-preview">{it().columns.map((c) => c.name).join(', ')}</span>}</Show>
          </button>
        }
      >
        <div class="entry-items">
          <For each={e().items}>{(it) => <ItemView item={it} entry={e()} session={props.session} latest={props.latest} />}</For>
        </div>
        <Show when={isBig(e()) && !props.latest}>
          <button class="collapse-btn" onClick={() => props.setCollapsed(true)} title="Collapse">
            ▴ collapse
          </button>
        </Show>
      </Show>
    </div>
  );
}

function InlineEditor(props: { entry: Entry; session: Session; onDone: () => void }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  onMount(() => {
    view = createEditor({
      parent: host,
      doc: props.entry.sql,
      catalog: props.session.catalog,
      autofocus: true,
      onRun: (sql) => {
        if (props.session.state.running) {
          toast('A query is already running', 'error');
          return;
        }
        props.session.send({ type: 'run', sql, entry_id: props.entry.id });
        props.onDone();
      },
      onEscape: () => {
        props.onDone();
        return true;
      },
    });
  });
  onCleanup(() => view?.destroy());
  return (
    <div class="inline-editor">
      <div class="editor-host" ref={host} />
      <div class="inline-editor-hint muted">
        Enter (after ;) or {modKey}Enter re-runs in place · Esc cancels
      </div>
    </div>
  );
}

function ItemView(props: { item: Item; entry: Entry; session: Session; latest: boolean }) {
  return (
    <Switch>
      <Match when={props.item.kind === 'rows' && (props.item as RowsItem)}>
        {(it) => <ResultCard item={it()} entry={props.entry} session={props.session} latest={props.latest} />}
      </Match>
      <Match when={props.item.kind === 'command' && props.item}>{(it) => <div class="cmd-tag">{(it() as { tag: string }).tag}</div>}</Match>
      <Match when={props.item.kind === 'text' && props.item}>{(it) => <TextOutput text={(it() as { text: string }).text} />}</Match>
      <Match when={props.item.kind === 'notice' && props.item}>{(it) => <ErrorView error={(it() as { notice: DbError }).notice} sql={props.entry.sql} />}</Match>
      <Match when={props.item.kind === 'error' && props.item}>
        {(it) => {
          const x = it() as { error: DbError; offset?: number };
          return <ErrorView error={x.error} sql={props.entry.sql} offset={x.offset} />;
        }}
      </Match>
      <Match when={props.item.kind === 'notification' && props.item}>
        {(it) => {
          const n = it() as { channel: string; payload: string; pid: number };
          return (
            <div class="notification">
              Asynchronous notification "{n.channel}"{n.payload ? ` with payload "${n.payload}"` : ''} received from server process with PID {n.pid}.
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

function TextOutput(props: { text: string }) {
  const linkify = (t: string): JSX.Element[] =>
    t.split(/(https?:\/\/\S+)/).map((p, i) => (i % 2 ? <a href={p} target="_blank" rel="noreferrer">{p}</a> : <>{p}</>));
  return <pre class="text-out">{linkify(props.text)}</pre>;
}

function ErrorView(props: { error: DbError; sql: string; offset?: number }) {
  const e = () => props.error;
  const isNotice = () => !['ERROR', 'FATAL', 'PANIC'].includes(e().severity);
  // psql-style "LINE n: ..." with a caret under the error position.
  const line = createMemo(() => {
    if (props.offset === undefined || props.offset > 1e15 || !e().position) return null;
    const idx = cpToIndex(props.sql, props.offset + e().position! - 1);
    const start = props.sql.lastIndexOf('\n', idx - 1) + 1;
    const endNl = props.sql.indexOf('\n', idx);
    const end = endNl < 0 ? props.sql.length : endNl;
    const lineNo = props.sql.slice(0, start).split('\n').length;
    const prefix = `LINE ${lineNo}: `;
    const text = props.sql.slice(start, end);
    return `${prefix}${text}\n${' '.repeat(prefix.length + [...props.sql.slice(start, idx)].length)}^`;
  });
  return (
    <div class="pg-msg" classList={{ notice: isNotice(), err: !isNotice() }}>
      <div class="pg-msg-main">
        <span class="sev">{e().severity}:</span> <span class="msg">{e().message}</span>
        <Show when={e().code && !isNotice()}>
          <span class="sqlstate" title="SQLSTATE">
            {e().code}
          </span>
        </Show>
      </div>
      <Show when={line()}>
        <pre class="pg-line">{line()}</pre>
      </Show>
      <Show when={e().detail}>
        <div>
          <span class="label">DETAIL:</span> <span class="pre">{e().detail}</span>
        </div>
      </Show>
      <Show when={e().hint}>
        <div>
          <span class="label">HINT:</span> <span class="pre">{e().hint}</span>
        </div>
      </Show>
      <Show when={e().internal_query}>
        <div>
          <span class="label">QUERY:</span> <span class="pre">{e().internal_query}</span>
        </div>
      </Show>
      <Show when={e().where}>
        <div>
          <span class="label">CONTEXT:</span> <span class="pre">{e().where}</span>
        </div>
      </Show>
    </div>
  );
}

function ResultCard(props: { item: RowsItem; entry: Entry; session: Session; latest: boolean }) {
  const data = createMemo(() => resultData(props.item));
  const [mode, setMode] = createSignal<'grid' | 'records' | null>(null);
  const [maximized, setMaximized] = createSignal(false);
  const [cell, setCell] = createSignal<{ r: number; c: number } | null>(null);
  const auto = () => {
    if (props.item.expanded) return 'records';
    if (props.session.state.settings.expanded === 'on') return 'records';
    if (props.session.state.settings.expanded === 'auto') {
      const est = props.item.columns.reduce((a, c) => a + Math.min(300, Math.max(c.name.length, 8) * 8 + 20), 40);
      return est > window.innerWidth - 120 ? 'records' : 'grid';
    }
    return 'grid';
  };
  const view = () => mode() ?? auto();
  const it = () => props.item;
  const filename = () => (it().title ? it().title!.replace(/[^\w.-]+/g, '_') : `pgc-${props.entry.id}`);
  const truncated = () => it().stored < it().row_count;
  const empty = () => it().columns.length === 0;

  const copyAll = async (header: boolean) => {
    const rows = await data().slice(0, data().stored);
    await copyText(formatRows('tsv', data().columns, rows, header));
    toast(`Copied ${plural(rows.length, 'row')}${header ? ' with headers' : ''}`);
  };
  const exportMenu = (ev: MouseEvent) =>
    openMenu(ev, [
      { label: 'Copy all (TSV)', action: () => copyAll(false) },
      { label: 'Copy all with headers', action: () => copyAll(true) },
      { separator: true, label: '' },
      ...(['csv', 'tsv', 'json'] as const).map((f) => ({
        label: `Download ${f.toUpperCase()}`,
        action: () => {
          const a = document.createElement('a');
          a.href = api.exportUrl(it().result_id, f, filename());
          a.click();
        },
      })),
    ]);

  return (
    <div class="result">
      <div class="result-head">
        <Show when={it().title}>
          <span class="result-title">{it().title}</span>
        </Show>
        <span class="muted">
          {it().tag && !it().tag!.startsWith('SELECT') ? `${it().tag} · ` : ''}
          {plural(it().row_count, 'row')}
          <Show when={truncated()}> (first {it().stored.toLocaleString()} kept)</Show>
        </span>
        <span class="spacer" />
        <Show when={!empty()}>
          <div class="seg">
            <button classList={{ on: view() === 'grid' }} onClick={() => setMode('grid')} title="Table view">
              ▦
            </button>
            <button classList={{ on: view() === 'records' }} onClick={() => setMode('records')} title="Expanded view (\x)">
              ☰
            </button>
          </div>
          <button class="icon-btn" title="Open large" onClick={() => setMaximized(true)}>
            ⤢
          </button>
          <button class="icon-btn" title="Copy / export" onClick={exportMenu}>
            ⇩
          </button>
        </Show>
      </div>
      <Show when={!empty()} fallback={<div class="muted small">(no columns)</div>}>
        <Show when={view() === 'grid'} fallback={<RecordView data={data()} onOpenCell={(r, c) => setCell({ r, c })} />}>
          <ResultGrid data={data()} maxHeight={Math.round(window.innerHeight * 0.6)} onOpenCell={(r, c) => setCell({ r, c })} filename={filename()} />
        </Show>
      </Show>
      <Show when={it().footer?.length}>
        <pre class="result-footer">{it().footer!.join('\n')}</pre>
      </Show>
      <Show when={data().missing()}>
        <div class="muted small">Only the first {data().stored.toLocaleString()} rows were saved with the session; re-run for the full result.</div>
      </Show>
      <Show when={maximized()}>
        <Modal title={it().title ?? `${plural(it().row_count, 'row')}`} onClose={() => setMaximized(false)} class="max">
          <ResultGrid data={data()} maxHeight={window.innerHeight - 110} onOpenCell={(r, c) => setCell({ r, c })} filename={filename()} />
        </Modal>
      </Show>
      <Show when={cell()}>{(c) => <CellViewer data={data()} r={c().r} c={c().c} onClose={() => setCell(null)} />}</Show>
    </div>
  );
}

function CellViewer(props: { data: ResultData; r: number; c: number; onClose: () => void }) {
  const col = () => props.data.columns[props.c];
  const value = () => {
    props.data.version();
    return props.data.rows[props.r]?.[props.c];
  };
  const pretty = () => (value() === null || value() === undefined ? '' : prettyValue(value()!, col()));
  return (
    <Modal title={`${col().name} · ${col().type_name} · row ${props.r + 1}`} onClose={props.onClose} wide>
      <div class="cell-view">
        <Show when={value() !== null} fallback={<span class="nul">NULL</span>}>
          <pre>{pretty()}</pre>
        </Show>
      </div>
      <div class="modal-actions">
        <span class="muted small">{value() ? `${[...value()!].length.toLocaleString()} characters` : ''}</span>
        <span class="spacer" />
        <button class="btn" onClick={() => copyText(value() ?? '').then(() => toast('Copied value'))}>
          Copy
        </button>
        <Show when={pretty() !== value()}>
          <button class="btn" onClick={() => copyText(pretty()).then(() => toast('Copied formatted value'))}>
            Copy formatted
          </button>
        </Show>
      </div>
    </Modal>
  );
}

function RecordView(props: { data: ResultData; onOpenCell: (r: number, c: number) => void }) {
  const [limit, setLimit] = createSignal(50);
  const [rows] = createResource(
    () => [props.data, limit()] as const,
    ([d, l]) => d.slice(0, Math.min(l, d.stored)),
  );
  // Width in `ch` of the monospace font (plus padding), capped for very long names.
  const nameW = () => Math.min(40, Math.max(...props.data.columns.map((c) => [...c.name].length))) + 3;
  return (
    <div class="records" style={{ 'max-height': `${Math.round(window.innerHeight * 0.6)}px` }}>
      <For each={rows() ?? []}>
        {(row, r) => (
          <div class="record">
            <div class="record-head">
              -[ RECORD {r() + 1} ]-
              <button
                class="icon-btn small"
                title="Copy record as JSON"
                onClick={() => copyText(formatRows('json', props.data.columns, [row], false)).then(() => toast('Copied record as JSON'))}
              >
                ⧉
              </button>
            </div>
            <For each={props.data.columns}>
              {(col, c) => (
                <div class="record-row">
                  <div class="record-key" style={{ width: `${nameW()}ch` }} title={col.type_name}>
                    {col.name}
                  </div>
                  <div class="record-val" classList={{ nul: row[c()] === null, num: col.numeric }} onDblClick={() => props.onOpenCell(r(), c())}>
                    {row[c()] === null ? 'NULL' : displayValue(row[c()]!, 2000).replace(/↵/g, '\n')}
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      <Show when={props.data.stored > limit()}>
        <button class="btn" onClick={() => setLimit((l) => l * 4)}>
          Show more records ({(props.data.stored - limit()).toLocaleString()} remaining)
        </button>
      </Show>
    </div>
  );
}
