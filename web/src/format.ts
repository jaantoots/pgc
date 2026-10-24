import type { Column, Row } from './types';

/** Quote a field for TSV/CSV the way spreadsheets expect. */
function field(v: string, sep: string): string {
  return v.includes(sep) || v.includes('"') || v.includes('\n') || v.includes('\r') ? `"${v.replace(/"/g, '""')}"` : v;
}

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'sql-in' | 'sql-values';

export function formatRows(format: CopyFormat, columns: Column[], rows: Row[], header: boolean): string {
  switch (format) {
    case 'tsv':
    case 'csv': {
      const sep = format === 'tsv' ? '\t' : ',';
      const lines = rows.map((r) => r.map((v) => (v === null ? '' : field(v, sep))).join(sep));
      if (header) lines.unshift(columns.map((c) => field(c.name, sep)).join(sep));
      return lines.join('\n');
    }
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(r[i], c)]))),
        null,
        2,
      );
    case 'markdown': {
      const cell = (v: string | null) => (v === null ? 'NULL' : v.replace(/\|/g, '\\|').replace(/\n/g, '<br>'));
      const head = `| ${columns.map((c) => cell(c.name)).join(' | ')} |`;
      const sepLine = `| ${columns.map((c) => (c.numeric ? '---:' : '---')).join(' | ')} |`;
      return [head, sepLine, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
    }
    case 'sql-in': {
      const vals = rows.flatMap((r) => r.map((v, i) => sqlLiteral(v, columns[i])));
      return `(${vals.join(', ')})`;
    }
    case 'sql-values':
      return rows.map((r) => `(${r.map((v, i) => sqlLiteral(v, columns[i])).join(', ')})`).join(',\n');
  }
}

function jsonValue(v: string | null, c: Column): unknown {
  if (v === null) return null;
  if (c.type_name === 'json' || c.type_name === 'jsonb') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (c.type_name === 'boolean') return v === 't';
  if (c.numeric && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v) && Number.isSafeInteger(Math.trunc(Number(v)))) return Number(v);
  return v;
}

export function sqlLiteral(v: string | null, c?: Column): string {
  if (v === null) return 'NULL';
  if (c?.numeric && /^-?\d+(\.\d+)?$/.test(v)) return v;
  if (c?.type_name === 'boolean') return v === 't' ? 'true' : 'false';
  return `'${v.replace(/'/g, "''")}'`;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Display form of a cell value in the grid (single line). */
export function displayValue(v: string, max = 300): string {
  const s = v.length > max ? v.slice(0, max) + '…' : v;
  return s.replace(/\r?\n/g, '↵').replace(/\t/g, '→');
}

export function prettyValue(v: string, c?: Column): string {
  if (c && (c.type_name === 'json' || c.type_name === 'jsonb')) {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return v;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}

export function relTime(ts: number): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
