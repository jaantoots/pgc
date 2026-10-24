import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount } from 'solid-js';
import { api } from './api';
import { type CopyFormat, copyText, displayValue, formatRows, plural } from './format';
import type { ResultData } from './results';
import { openMenu, toast, modKey } from './ui';

const ROW_H = 24;
const HEADER_H = 38;
const OVERSCAN = 8;
const MIN_W = 44;
const MAX_W = 380;

interface Pos {
  r: number;
  c: number;
}

export interface GridProps {
  data: ResultData;
  maxHeight: number;
  onOpenCell: (r: number, c: number) => void;
  filename?: string;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(s: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 7.5;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

export default function ResultGrid(props: GridProps) {
  const d = () => props.data;
  const ncols = () => d().columns.length;
  const nrows = () => d().stored;
  let el!: HTMLDivElement;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewW, setViewW] = createSignal(800);
  const [viewH, setViewH] = createSignal(400);
  const [widths, setWidths] = createSignal<number[]>(d().columns.map(() => 120));
  const [anchor, setAnchor] = createSignal<Pos | null>(null);
  const [focus, setFocus] = createSignal<Pos | null>(null);

  const rnW = createMemo(() => Math.max(36, String(nrows()).length * 8 + 18));
  const offsets = createMemo(() => {
    const o = [0];
    for (const w of widths()) o.push(o[o.length - 1] + w);
    return o;
  });
  const totalW = () => offsets()[ncols()] + rnW();
  const totalH = () => HEADER_H + nrows() * ROW_H;

  const firstRow = () => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
  const lastRow = () => Math.min(nrows(), Math.ceil((scrollTop() + viewH()) / ROW_H) + OVERSCAN);
  const visibleRows = createMemo(() => {
    const out: number[] = [];
    for (let r = firstRow(); r < lastRow(); r++) out.push(r);
    return out;
  });
  const colRange = createMemo(() => {
    const o = offsets();
    const left = scrollLeft();
    const right = left + viewW();
    let c0 = 0;
    while (c0 < ncols() - 1 && o[c0 + 1] < left - 200) c0++;
    let c1 = c0;
    while (c1 < ncols() && o[c1] < right + 200) c1++;
    return [c0, c1] as const;
  });
  const visibleCols = createMemo(() => {
    const [c0, c1] = colRange();
    const out: number[] = [];
    for (let c = c0; c < c1; c++) out.push(c);
    return out;
  });
  const padLeft = () => offsets()[colRange()[0]];

  const sel = createMemo(() => {
    const a = anchor();
    const f = focus();
    if (!a || !f) return null;
    return { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) };
  });
  const inSel = (r: number, c: number) => {
    const s = sel();
    return !!s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1;
  };
  const isFocus = (r: number, c: number) => {
    const f = focus();
    return !!f && f.r === r && f.c === c;
  };

  // Load rows as they scroll into view.
  createEffect(() => {
    void d().ensure(firstRow(), lastRow());
  });

  onMount(() => {
    const font = getComputedStyle(el).font || '12px monospace';
    const headFont = font.replace(/^(normal |)/, '600 ');
    const sample = Math.min(nrows(), 300);
    const w = d().columns.map((col, c) => {
      let max = Math.max(textWidth(col.name, headFont), textWidth(col.type_name, font) * 0.85);
      for (let r = 0; r < sample; r++) {
        const v = d().rows[r]?.[c];
        max = Math.max(max, textWidth(v === null || v === undefined ? 'NULL' : displayValue(v, 80), font));
      }
      return Math.round(Math.min(MAX_W, Math.max(MIN_W, max + 18)));
    });
    setWidths(w);
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const onScroll = () => {
    setScrollTop(el.scrollTop);
    setScrollLeft(el.scrollLeft);
  };

  // ---- selection with mouse ----
  let dragging = false;
  const cellAt = (e: MouseEvent): Pos | null => {
    const t = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
    if (!t) return null;
    return { r: Number(t.dataset.r), c: Number(t.dataset.c) };
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = cellAt(e);
    if (!p) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    if (p.r === -1 && p.c === -1) {
      selectAll();
      return;
    }
    const full: Pos = { r: p.r === -1 ? nrows() - 1 : p.r, c: p.c === -1 ? ncols() - 1 : p.c };
    const start: Pos = { r: p.r === -1 ? 0 : p.r, c: p.c === -1 ? 0 : p.c };
    if (e.shiftKey && anchor()) {
      const a = anchor()!;
      // Extend whole rows/columns when extending from a header.
      setFocus(full);
      if (p.r === -1) setAnchor({ r: 0, c: a.c });
      if (p.c === -1) setAnchor({ r: a.r, c: 0 });
    } else {
      setAnchor(start);
      setFocus(full);
    }
    dragging = true;
    dragMode = p.r === -1 ? 'col' : p.c === -1 ? 'row' : 'cell';
  };
  let dragMode: 'cell' | 'row' | 'col' = 'cell';
  const onWindowMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = el.getBoundingClientRect();
    if (e.clientY > rect.bottom - 4) el.scrollTop += Math.min(40, e.clientY - rect.bottom + 8);
    if (e.clientY < rect.top + HEADER_H) el.scrollTop -= Math.min(40, rect.top + HEADER_H - e.clientY + 4);
    if (e.clientX > rect.right - 4) el.scrollLeft += Math.min(40, e.clientX - rect.right + 8);
    if (e.clientX < rect.left + rnW()) el.scrollLeft -= Math.min(40, rect.left + rnW() - e.clientX + 4);
    const x = Math.min(Math.max(e.clientX, rect.left + rnW() + 1), rect.right - 2);
    const y = Math.min(Math.max(e.clientY, rect.top + HEADER_H + 1), rect.bottom - 2);
    const r = Math.min(nrows() - 1, Math.max(0, Math.floor((y - rect.top - HEADER_H + el.scrollTop) / ROW_H)));
    const px = x - rect.left - rnW() + el.scrollLeft;
    const o = offsets();
    let c = 0;
    while (c < ncols() - 1 && o[c + 1] <= px) c++;
    if (dragMode === 'col') setFocus({ r: nrows() - 1, c });
    else if (dragMode === 'row') setFocus({ r, c: ncols() - 1 });
    else setFocus({ r, c });
  };
  const onWindowUp = () => (dragging = false);
  onMount(() => {
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
  });
  onCleanup(() => {
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup', onWindowUp);
  });

  const selectAll = () => {
    if (!nrows() || !ncols()) return;
    setAnchor({ r: 0, c: 0 });
    setFocus({ r: nrows() - 1, c: ncols() - 1 });
  };

  const scrollIntoView = (p: Pos) => {
    const top = p.r * ROW_H;
    const viewRows = el.clientHeight - HEADER_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + viewRows) el.scrollTop = top + ROW_H - viewRows;
    const left = offsets()[p.c];
    const right = offsets()[p.c + 1];
    const viewCols = el.clientWidth - rnW();
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + viewCols) el.scrollLeft = right - viewCols;
  };

  // ---- copy ----
  const copy = async (format: CopyFormat, header: boolean) => {
    const s = sel();
    if (!s) return;
    const rows = await d().slice(s.r0, s.r1 + 1);
    const cols = d().columns.slice(s.c0, s.c1 + 1);
    const sliced = rows.map((r) => r.slice(s.c0, s.c1 + 1));
    await copyText(formatRows(format, cols, sliced, header));
    const label = format === 'tsv' ? '' : ` as ${format.toUpperCase()}`;
    toast(`Copied ${plural(sliced.length, 'row')} × ${plural(cols.length, 'column')}${label}`);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void copy('tsv', e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
      return;
    }
    const f = focus();
    if (e.key === 'Escape') {
      if (sel()) {
        e.stopPropagation();
        setAnchor(null);
        setFocus(null);
      }
      return;
    }
    if (!f) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onOpenCell(f.r, f.c);
      return;
    }
    const page = Math.max(1, Math.floor((el.clientHeight - HEADER_H) / ROW_H) - 1);
    let n: Pos | null = null;
    switch (e.key) {
      case 'ArrowUp':
        n = { r: mod ? 0 : f.r - 1, c: f.c };
        break;
      case 'ArrowDown':
        n = { r: mod ? nrows() - 1 : f.r + 1, c: f.c };
        break;
      case 'ArrowLeft':
        n = { r: f.r, c: mod ? 0 : f.c - 1 };
        break;
      case 'ArrowRight':
        n = { r: f.r, c: mod ? ncols() - 1 : f.c + 1 };
        break;
      case 'Tab':
        n = { r: f.r, c: f.c + (e.shiftKey ? -1 : 1) };
        break;
      case 'PageDown':
        n = { r: f.r + page, c: f.c };
        break;
      case 'PageUp':
        n = { r: f.r - page, c: f.c };
        break;
      case 'Home':
        n = { r: mod ? 0 : f.r, c: 0 };
        break;
      case 'End':
        n = { r: mod ? nrows() - 1 : f.r, c: ncols() - 1 };
        break;
    }
    if (!n) return;
    e.preventDefault();
    n = { r: Math.max(0, Math.min(nrows() - 1, n.r)), c: Math.max(0, Math.min(ncols() - 1, n.c)) };
    setFocus(n);
    if (!e.shiftKey || e.key === 'Tab') setAnchor(n);
    scrollIntoView(n);
  };

  const onContextMenu = (e: MouseEvent) => {
    const p = cellAt(e);
    if (p && p.r >= 0 && p.c >= 0 && !inSel(p.r, p.c)) {
      setAnchor(p);
      setFocus(p);
    }
    const s = sel();
    const cnt = s ? (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) : 0;
    const exp = (fmt: string) => () => {
      const a = document.createElement('a');
      a.href = api.exportUrl(d().id, fmt, props.filename);
      a.click();
    };
    openMenu(e, [
      { label: 'Copy', hint: `${modKey}C`, action: () => copy('tsv', false), disabled: !cnt },
      { label: 'Copy with headers', hint: `${modKey}⇧C`, action: () => copy('tsv', true), disabled: !cnt },
      { label: 'Copy as CSV', action: () => copy('csv', true), disabled: !cnt },
      { label: 'Copy as JSON', action: () => copy('json', false), disabled: !cnt },
      { label: 'Copy as Markdown', action: () => copy('markdown', false), disabled: !cnt },
      { label: 'Copy as SQL IN (…)', action: () => copy('sql-in', false), disabled: !cnt },
      { label: 'Copy as SQL VALUES', action: () => copy('sql-values', false), disabled: !cnt },
      { separator: true, label: '' },
      { label: 'View value', hint: 'Enter', action: () => focus() && props.onOpenCell(focus()!.r, focus()!.c), disabled: !focus() },
      { label: 'Select all', hint: `${modKey}A`, action: selectAll },
      { separator: true, label: '' },
      { label: 'Export all rows as CSV', action: exp('csv') },
      { label: 'Export all rows as TSV', action: exp('tsv') },
      { label: 'Export all rows as JSON', action: exp('json') },
    ]);
  };

  // ---- column resize ----
  const startResize = (c: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths()[c];
    const move = (ev: MouseEvent) => {
      const w = Math.max(30, w0 + ev.clientX - x0);
      setWidths((ws) => ws.map((v, i) => (i === c ? w : v)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const autofit = (c: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const font = getComputedStyle(el).font;
    let max = textWidth(d().columns[c].name, font);
    for (let r = 0; r < Math.min(nrows(), 2000); r++) {
      const v = d().rows[r]?.[c];
      if (v) max = Math.max(max, textWidth(displayValue(v, 400), font));
    }
    setWidths((ws) => ws.map((v, i) => (i === c ? Math.min(1200, Math.round(max + 20)) : v)));
  };

  // Reset selection when the data changes identity.
  createEffect(on(() => d().id, () => (setAnchor(null), setFocus(null)), { defer: true }));

  const cellValue = (r: number, c: number) => {
    d().version();
    return d().rows[r]?.[c];
  };

  return (
    <div
      class="grid"
      ref={el}
      tabIndex={0}
      style={{ 'max-height': `${props.maxHeight}px`, height: `${Math.min(props.maxHeight, totalH() + (totalW() > viewW() + 1 ? 16 : 2))}px` }}
      onScroll={onScroll}
      onMouseDown={onMouseDown}
      onDblClick={(e) => {
        const p = cellAt(e);
        if (p && p.r >= 0 && p.c >= 0) props.onOpenCell(p.r, p.c);
      }}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      <div class="grid-canvas" style={{ width: `${totalW()}px`, height: `${totalH()}px` }}>
        <div class="grid-header" style={{ height: `${HEADER_H}px`, width: `${totalW()}px` }}>
          <div class="rn corner" style={{ width: `${rnW()}px` }} data-r="-1" data-c="-1" title="Select all" />
          <div style={{ width: `${padLeft()}px`, 'flex-shrink': 0 }} />
          <Index each={visibleCols()}>
            {(c) => {
              const col = () => d().columns[c()];
              const s = () => {
                const x = sel();
                return !!x && c() >= x.c0 && c() <= x.c1;
              };
              return (
                <div class="hc" classList={{ num: col().numeric, sel: s() }} style={{ width: `${widths()[c()]}px` }} data-r="-1" data-c={c()} title={`${col().name} (${col().type_name})`}>
                  <div class="hc-name">{col().name}</div>
                  <div class="hc-type">{col().type_name}</div>
                  <div class="resize" onMouseDown={(e) => startResize(c(), e)} onDblClick={(e) => autofit(c(), e)} />
                </div>
              );
            }}
          </Index>
        </div>
        <div class="grid-rows" style={{ top: `${HEADER_H + firstRow() * ROW_H}px` }}>
          <Index each={visibleRows()}>
            {(r) => {
              const rowSel = () => {
                const x = sel();
                return !!x && r() >= x.r0 && r() <= x.r1;
              };
              return (
                <div class="gr" classList={{ odd: r() % 2 === 1 }} style={{ height: `${ROW_H}px` }}>
                  <div class="rn" classList={{ sel: rowSel() }} style={{ width: `${rnW()}px` }} data-r={r()} data-c="-1">
                    {r() + 1}
                  </div>
                  <div style={{ width: `${padLeft()}px`, 'flex-shrink': 0 }} />
                  <Index each={visibleCols()}>
                    {(c) => {
                      const v = () => cellValue(r(), c());
                      return (
                        <div
                          class="gc"
                          classList={{
                            num: d().columns[c()].numeric,
                            sel: inSel(r(), c()),
                            focus: isFocus(r(), c()),
                            nul: v() === null,
                            loading: v() === undefined,
                          }}
                          style={{ width: `${widths()[c()]}px` }}
                          data-r={r()}
                          data-c={c()}
                        >
                          {v() === null ? 'NULL' : v() === undefined ? '' : displayValue(v()!)}
                        </div>
                      );
                    }}
                  </Index>
                </div>
              );
            }}
          </Index>
        </div>
      </div>
    </div>
  );
}
