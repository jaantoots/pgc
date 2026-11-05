import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, completionStatus, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, type KeyBinding, keymap, placeholder as placeholderExt, drawSelection, runScopeHandlers, ViewPlugin } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import type { Catalog } from './catalog';
import { pgCompletion } from './completion';
import { pgHover } from './hover';
import { metaBindings, metaKeyName } from './metakeys';
import { onPrefs, type Prefs, prefs } from './prefs';
import { isComplete } from './sqlscan';

export interface EditorOptions {
  parent: HTMLElement;
  doc?: string;
  placeholder?: string;
  catalog: () => Catalog | null;
  /** Run the buffer. Return false to keep the text (e.g. not connected). */
  onRun: (text: string) => void;
  onEscape?: () => boolean;
  /** Ctrl+C with an empty selection; return true if handled. */
  onInterrupt?: () => boolean;
  onChange?: (text: string) => void;
  /** History navigation; return the text to show, or null for no change. */
  onHistory?: (dir: -1 | 1, current: string) => string | null;
  onHistorySearch?: () => void;
  autofocus?: boolean;
}

export const sqlLanguage = sql({ dialect: PostgreSQL, upperCaseKeywords: false });

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function atDocEnd(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  return view.state.doc.sliceString(sel.head).trim() === '';
}

// ---- vim ----

function vimState(view: EditorView) {
  const cm = getCM(view);
  return cm ? Vim.maybeInitVimState_(cm) : null;
}

/** Vim is on and not in insert mode (normal, visual, or a command in progress). */
function vimCommandMode(view: EditorView): boolean {
  const v = vimState(view);
  return !!v && !v.insertMode;
}

/** Vim normal mode with nothing pending: no count, operator or partial command. */
function vimIdle(view: EditorView): boolean {
  const v = vimState(view);
  if (!v || v.insertMode || v.visualMode) return false;
  const i = v.inputState;
  return !i.keyBuffer.length && !i.prefixRepeat.length && !i.motionRepeat.length && !i.operator;
}

/** New buffers start in insert mode, like readline's vi mode. */
function vimInsert(view: EditorView) {
  const cm = getCM(view);
  const v = vimState(view);
  if (!cm || !v || v.insertMode) return;
  if (v.visualMode || !vimIdle(view)) Vim.handleKey(cm, '<Esc>', 'mapping');
  const head = view.state.selection.main.head;
  const atEnd = head === view.state.doc.lineAt(head).to;
  Vim.handleKey(cm, atEnd ? 'A' : 'i', 'mapping');
}

const editorOptions = new WeakMap<EditorView, EditorOptions>();
const exOptions = (cm: { cm6?: EditorView }) => (cm.cm6 ? editorOptions.get(cm.cm6) : undefined);
Vim.defineEx('write', 'w', (cm: { cm6?: EditorView }) => {
  const view = cm.cm6;
  const o = exOptions(cm);
  const text = view?.state.doc.toString() ?? '';
  if (o && text.trim()) o.onRun(text);
});
Vim.defineEx('quit', 'q', (cm: { cm6?: EditorView }) => void exOptions(cm)?.onEscape?.());

// ---- Alt/Option as Meta ----

const metaKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      const name = metaKeyName(e, isMac);
      const cmd = name ? metaBindings[name] : undefined;
      return cmd ? cmd(view) : false;
    },
  }),
);

function prefExtensions(p: Prefs): Extension {
  return [p.altMeta ? metaKeys : [], p.vim ? vim() : []];
}

export function createEditor(o: EditorOptions): EditorView {
  const historyStep = (view: EditorView, dir: -1 | 1): boolean => {
    if (!o.onHistory || completionStatus(view.state) === 'active') return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (line.number !== (dir < 0 ? 1 : view.state.doc.lines)) return false;
    const t = o.onHistory(dir, view.state.doc.toString());
    if (t === null) return false;
    const firstLineEnd = t.indexOf('\n') < 0 ? t.length : t.indexOf('\n');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: dir < 0 ? firstLineEnd : t.length } });
    return true;
  };

  // Scope "pgc": run by our own highest-precedence keydown handler, so they come before vim's.
  const bindings: KeyBinding[] = [
    {
      key: 'Enter',
      run: (view) => {
        if (completionStatus(view.state) === 'active') return false;
        const text = view.state.doc.toString();
        if (vimCommandMode(view)) {
          // Like Enter in readline's vi command mode: accept the buffer.
          if (!isComplete(text)) return false;
          o.onRun(text);
          return true;
        }
        if (atDocEnd(view) && isComplete(text)) {
          o.onRun(text);
          return true;
        }
        return insertNewlineAndIndent(view);
      },
    },
    { key: 'Shift-Enter', run: (view) => !vimCommandMode(view) && insertNewlineAndIndent(view) },
    {
      key: 'Mod-Enter',
      run: (view) => {
        const text = view.state.doc.toString();
        if (text.trim()) o.onRun(text);
        return true;
      },
    },
    { key: 'ArrowUp', run: (view) => historyStep(view, -1) },
    { key: 'ArrowDown', run: (view) => historyStep(view, 1) },
    // In vim normal mode, k/j past the first/last line walk the history too.
    { key: 'k', run: (view) => vimIdle(view) && historyStep(view, -1) },
    { key: 'j', run: (view) => vimIdle(view) && historyStep(view, 1) },
    {
      key: 'Escape',
      run: (view) => {
        const v = vimState(view);
        if (v && !vimIdle(view)) {
          // Let vim leave insert/visual mode or drop a pending command; one Esc also closes completions.
          if (v.insertMode) closeCompletion(view);
          return false;
        }
        if (completionStatus(view.state)) return false;
        return o.onEscape?.() ?? false;
      },
    },
    {
      key: 'Mod-r',
      run: (view) => {
        // Ctrl-R is redo in vim's normal mode.
        if (!isMac && vimCommandMode(view)) return false;
        o.onHistorySearch?.();
        return true;
      },
    },
    { key: 'Ctrl-Space', run: startCompletion },
    {
      // Tab completes like in a shell: accept the selected suggestion, or open the list.
      key: 'Tab',
      run: (view) => !vimCommandMode(view) && ((completionStatus(view.state) === 'active' ? acceptCompletion(view) : startCompletion(view)) || true),
    },
    {
      // psql habit: Ctrl+C cancels the running query (when nothing is selected).
      key: 'Ctrl-c',
      run: (view) => view.state.selection.main.empty && (o.onInterrupt?.() ?? false),
    },
  ];
  const runKeys = keymap.of(bindings.map((b) => ({ ...b, scope: 'pgc' })));

  const prefsCompartment = new Compartment();
  const followPrefs = ViewPlugin.define((view) => {
    let current = prefs();
    const off = onPrefs((p) => {
      if (p.vim === current.vim && p.altMeta === current.altMeta) return;
      const vimTurnedOn = p.vim && !current.vim;
      current = p;
      view.dispatch({ effects: prefsCompartment.reconfigure(prefExtensions(p)) });
      if (vimTurnedOn) vimInsert(view);
    });
    return { destroy: off };
  });

  const extensions: Extension[] = [
    // Vim goes before every keymap so its handler sees keys before the standard bindings do.
    prefsCompartment.of(prefExtensions(prefs())),
    Prec.highest(EditorView.domEventHandlers({ keydown: (e, view) => runScopeHandlers(view, e, 'pgc') })),
    runKeys,
    followPrefs,
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    sqlLanguage,
    syntaxHighlighting(classHighlighter),
    autocompletion({ override: [pgCompletion(o.catalog)], activateOnTyping: true, maxRenderedOptions: 80, icons: false }),
    pgHover(o.catalog),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap]),
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange?.(u.state.doc.toString());
    }),
  ];
  if (o.placeholder) extensions.push(placeholderExt(o.placeholder));
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({ doc: o.doc ?? '', extensions }),
  });
  editorOptions.set(view, o);
  if (o.autofocus) {
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }
  vimInsert(view);
  return view;
}

export function setDoc(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
  vimInsert(view);
}
