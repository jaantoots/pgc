import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt, drawSelection } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { type Catalog, pgCompletion } from './completion';
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

function atDocEnd(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  return view.state.doc.sliceString(sel.head).trim() === '';
}

export function createEditor(o: EditorOptions): EditorView {
  const runKeys = keymap.of([
    {
      key: 'Enter',
      run: (view) => {
        if (completionStatus(view.state) === 'active') return false;
        const text = view.state.doc.toString();
        if (atDocEnd(view) && isComplete(text)) {
          o.onRun(text);
          return true;
        }
        return insertNewlineAndIndent(view);
      },
    },
    { key: 'Shift-Enter', run: insertNewlineAndIndent },
    {
      key: 'Mod-Enter',
      run: (view) => {
        const text = view.state.doc.toString();
        if (text.trim()) o.onRun(text);
        return true;
      },
    },
    {
      key: 'ArrowUp',
      run: (view) => {
        if (!o.onHistory || completionStatus(view.state) === 'active') return false;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        if (line.number !== 1) return false;
        const t = o.onHistory(-1, view.state.doc.toString());
        if (t === null) return false;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: Math.min(t.indexOf('\n') < 0 ? t.length : t.indexOf('\n'), t.length) } });
        return true;
      },
    },
    {
      key: 'ArrowDown',
      run: (view) => {
        if (!o.onHistory || completionStatus(view.state) === 'active') return false;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        if (line.number !== view.state.doc.lines) return false;
        const t = o.onHistory(1, view.state.doc.toString());
        if (t === null) return false;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: t.length } });
        return true;
      },
    },
    { key: 'Escape', run: (view) => (completionStatus(view.state) ? false : (o.onEscape?.() ?? false)) },
    {
      key: 'Mod-r',
      preventDefault: true,
      run: () => {
        o.onHistorySearch?.();
        return true;
      },
    },
    { key: 'Ctrl-Space', run: startCompletion },
    {
      // psql habit: Ctrl+C cancels the running query (when nothing is selected).
      key: 'Ctrl-c',
      run: (view) => view.state.selection.main.empty && (o.onInterrupt?.() ?? false),
    },
  ]);

  const extensions: Extension[] = [
    Prec.highest(runKeys),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    sqlLanguage,
    syntaxHighlighting(classHighlighter),
    autocompletion({ override: [pgCompletion(o.catalog)], activateOnTyping: true, maxRenderedOptions: 80, icons: false }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
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
  if (o.autofocus) {
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }
  return view;
}

export function setDoc(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
}
