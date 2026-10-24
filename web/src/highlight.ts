import { highlightTree, classHighlighter } from '@lezer/highlight';
import { sqlLanguage } from './editor';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Render SQL as highlighted HTML using the same token classes as the editor.
 * `mark` optionally highlights a character offset (an error position).
 */
export function highlightSql(text: string, mark?: number): string {
  const tree = sqlLanguage.language.parser.parse(text);
  const spans: [number, number, string][] = [];
  highlightTree(tree, classHighlighter, (from, to, cls) => spans.push([from, to, cls]));
  let out = '';
  let pos = 0;
  const emit = (from: number, to: number, cls?: string) => {
    if (from >= to) return;
    const piece = (a: number, b: number, extra?: string) => {
      if (a >= b) return;
      const c = [cls, extra].filter(Boolean).join(' ');
      out += c ? `<span class="${c}">${esc(text.slice(a, b))}</span>` : esc(text.slice(a, b));
    };
    if (mark !== undefined && mark >= from && mark < to) {
      piece(from, mark);
      piece(mark, mark + 1, 'err-mark');
      piece(mark + 1, to);
    } else piece(from, to);
  };
  for (const [from, to, cls] of spans) {
    emit(pos, from);
    emit(from, to, cls);
    pos = to;
  }
  emit(pos, text.length);
  if (mark !== undefined && mark >= text.length) out += '<span class="err-mark"> </span>';
  return out;
}
