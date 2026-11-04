import {
  cursorDocEnd,
  cursorDocStart,
  cursorGroupBackward,
  cursorGroupForward,
  deleteGroupBackward,
  deleteGroupForward,
  selectGroupBackward,
  selectGroupForward,
} from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/**
 * The Meta key a keydown stands for when Alt/Option is Meta, e.g. "b", "Shift-b", "<", "Backspace",
 * or null if it isn't a plain Alt combination. On macOS `key` is whatever Option typed ("∫" for
 * Option+B), so letters come from `keyCode` (which follows the keyboard layout) and `<`/`>` from
 * the physical comma/period keys.
 */
export function metaKeyName(e: KeyLike, mac: boolean): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === 'Backspace' || e.key === 'Delete') return e.key;
  let ch: string | null = null;
  if (e.keyCode >= 65 && e.keyCode <= 90) ch = String.fromCharCode(e.keyCode + 32);
  else if (!mac && e.key.length === 1) ch = e.key;
  else if (e.code === 'Comma') ch = e.shiftKey ? '<' : ',';
  else if (e.code === 'Period') ch = e.shiftKey ? '>' : '.';
  if (!ch) return null;
  return e.shiftKey && /^[a-z]$/.test(ch) ? `Shift-${ch}` : ch;
}

export type CaseMode = 'upper' | 'lower' | 'capitalize';

const wordRe = /[^\p{L}\p{N}_]*([\p{L}\p{N}_]+)/uy;

/** readline's M-u / M-l / M-c on `text` (the document from the cursor on): what to replace, relative to the cursor. */
export function caseWord(text: string, mode: CaseMode): { from: number; to: number; insert: string } | null {
  wordRe.lastIndex = 0;
  const m = wordRe.exec(text);
  if (!m) return null;
  const to = m[0].length;
  const from = to - m[1].length;
  const w = m[1];
  const insert = mode === 'upper' ? w.toUpperCase() : mode === 'lower' ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return { from, to, insert };
}

function caseCommand(mode: CaseMode): Command {
  return (view: EditorView) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const c = caseWord(state.doc.sliceString(range.head), mode);
      if (!c) return { range: EditorSelection.cursor(state.doc.length) };
      const from = range.head + c.from;
      const to = range.head + c.to;
      return { changes: { from, to, insert: c.insert }, range: EditorSelection.cursor(to) };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/** readline's Meta bindings. */
export const metaBindings: Record<string, Command> = {
  b: cursorGroupBackward,
  f: cursorGroupForward,
  'Shift-b': selectGroupBackward,
  'Shift-f': selectGroupForward,
  d: deleteGroupForward,
  Backspace: deleteGroupBackward,
  Delete: deleteGroupForward,
  '<': cursorDocStart,
  '>': cursorDocEnd,
  u: caseCommand('upper'),
  l: caseCommand('lower'),
  c: caseCommand('capitalize'),
};
