import { api } from '../api';
import type { Commit, Entry, GitStatus, ReadResult, RootInfo } from './types';

const qs = (root: number, path: string, extra = '') => `root=${root}&path=${encodeURIComponent(path)}${extra}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export type WriteResult = { ok: true; mtime: number; size: number } | { ok: false; conflict: true; mtime: number; error: string };

export const filesApi = {
  roots: () => api<{ roots: RootInfo[] }>('/api/files/roots'),
  list: (root: number, path: string) => api<{ entries: Entry[]; truncated: boolean }>(`/api/files/list?${qs(root, path)}`),
  read: (root: number, path: string) => api<ReadResult>(`/api/files/read?${qs(root, path)}`),
  rawUrl: (root: number, path: string) => `/api/files/raw?${qs(root, path)}`,
  async write(root: number, path: string, content: string, expected_mtime?: number): Promise<WriteResult> {
    const res = await fetch('/api/files/write', {
      method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path, content, expected_mtime }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; mtime?: number; size?: number };
    if (res.status === 409) return { ok: false, conflict: true, mtime: data.mtime ?? 0, error: data.error ?? 'conflito' };
    if (!res.ok) throw new Error(data.error ?? `erro ${res.status}`);
    return { ok: true, mtime: data.mtime ?? 0, size: data.size ?? 0 };
  },
  mkdir: (root: number, path: string) => api<{ path: string }>('/api/files/mkdir', json('POST', { root, path })),
  create: (root: number, path: string) => api<{ path: string }>('/api/files/create', json('POST', { root, path })),
  rename: (root: number, from: string, to: string) => api<{ from: string; to: string }>('/api/files/rename', json('POST', { root, from, to })),
  move: (root: number, from: string, to: string) => api<{ from: string; to: string }>('/api/files/move', json('POST', { root, from, to })),
  remove: (root: number, path: string) => api<{ ok: true }>('/api/files/delete', json('POST', { root, path })),
  gitStatus: (root: number) => api<GitStatus>(`/api/files/git-status?root=${root}`),
  timeline: (root: number, path: string) => api<{ repo: boolean; commits: Commit[] }>(`/api/files/timeline?${qs(root, path)}`),
  search: (root: number, q: string) => api<{ matches: { path: string; type: 'file' | 'dir' }[]; truncated: boolean }>(`/api/files/search?root=${root}&q=${encodeURIComponent(q)}`),
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
