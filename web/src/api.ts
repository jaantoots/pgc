import type { HistoryRow, Row, Service, SessionInfo } from './types';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error((await res.text()) || `${res.status} ${res.statusText}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  sessions: () => req<SessionInfo[]>('GET', '/api/sessions'),
  session: (id: string) => req<SessionInfo>('GET', `/api/sessions/${id}`),
  createSession: (conninfo?: string) => req<{ id: string }>('POST', '/api/sessions', { conninfo }),
  renameSession: (id: string, name: string | null) => req<void>('PATCH', `/api/sessions/${id}`, { name }),
  deleteSession: (id: string) => req<void>('DELETE', `/api/sessions/${id}`),
  hideEntry: (id: string) => req<void>('DELETE', `/api/entries/${id}`),
  rows: (resultId: string, offset: number, limit: number) =>
    req<{ offset: number; rows: Row[]; available: number; row_count: number }>(
      'GET',
      `/api/results/${resultId}/rows?offset=${offset}&limit=${limit}`,
    ),
  exportUrl: (resultId: string, format: string, filename?: string) =>
    `/api/results/${resultId}/export?format=${format}${filename ? `&filename=${encodeURIComponent(filename)}` : ''}`,
  history: (q: string, limit = 200, session?: string) =>
    req<HistoryRow[]>(
      'GET',
      `/api/history?q=${encodeURIComponent(q)}&limit=${limit}${session ? `&session=${session}` : ''}`,
    ),
  services: () => req<Service[]>('GET', '/api/services'),
  defaults: () => req<{ conninfo: string }>('GET', '/api/defaults'),
};
