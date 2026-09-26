import { api } from '../api';
import type { Row } from './live';

export type ApiSession = {
  id: string; title: string; status: 'running' | 'waiting' | 'idle' | 'error'; cost_usd: number; turns: number; model: string | null;
  permission_mode: string; cwd: string; last_error: string | null; archived?: boolean; created_at: string; updated_at: string;
  user_name: string; project_slug: string | null; project_name: string | null; pending: number;
};
export type Project = { id: number; slug: string; name: string; path: string; rules: string | null };
export type Mode = 'acceptEdits' | 'default' | 'plan' | 'auto';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Me = { id: number; name: string; email: string; role: string };
/** Anexo já salvo no servidor pelo endpoint de upload. */
export type Attachment = { kind: 'image' | 'file'; media_type: string; name: string; path: string; size?: number };

export const claudeApi = {
  status: () => api<{ logged_in: boolean; home: string; version: string; linux_user: string | null }>('/api/claude/status'),
  me: () => api<{ user: Me }>('/api/me'),
  projects: () => api<{ projects: Project[] }>('/api/claude/projects'),
  sessions: () => api<{ sessions: ApiSession[] }>('/api/claude/sessions'),
  usage: () => api<{ usage: { id: number; name: string; cost_5h: string; cost_7d: string; cost_total: string; sessions: string }[] }>('/api/claude/usage'),
  create: (b: { project_id: number; prompt: string; permission_mode: Mode; effort?: Effort; attachments?: Attachment[] }) => api<{ id: string; title: string }>('/api/claude/sessions', { method: 'POST', body: JSON.stringify(b) }),
  get: (id: string) => api<{ session: ApiSession; events: Row[]; pending: { id: string; toolName: string }[] }>(`/api/claude/sessions/${id}`),
  send: (id: string, b: { prompt: string; permission_mode?: Mode; effort?: Effort; attachments?: Attachment[] }) => api<{ ok: true; queued: boolean }>(`/api/claude/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify(b) }),
  // Upload multipart: não passa pelo helper `api` (que forçaria Content-Type JSON); o navegador define o boundary.
  uploads: async (files: File[]): Promise<{ attachments: Attachment[] }> => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    const res = await fetch('/api/claude/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error ?? `erro ${res.status}`);
    return data as { attachments: Attachment[] };
  },
  permission: (id: string, b: { approval_id: string; decision: 'allow' | 'allow_always' | 'deny' | 'answer'; message?: string }) => api<{ ok: true }>(`/api/claude/sessions/${id}/permission`, { method: 'POST', body: JSON.stringify(b) }),
  stop: (id: string) => api<{ ok: true }>(`/api/claude/sessions/${id}/stop`, { method: 'POST' }),
  rename: (id: string, title: string) => api<{ ok: true }>(`/api/claude/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) }),
  archive: (id: string, archived: boolean) => api<{ ok: true; archived: boolean }>(`/api/claude/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  remove: (id: string) => api<{ ok: true }>(`/api/claude/sessions/${id}`, { method: 'DELETE' }),
};

export const MODE_LABEL: Record<Mode, string> = { acceptEdits: 'Edição automática', default: 'Manual', plan: 'Plan', auto: 'Auto' };
export const MODE_DESC: Record<Mode, string> = {
  default: 'Pede aprovação antes de cada edição ou comando',
  acceptEdits: 'Aceita edições de arquivo automaticamente nesta sessão',
  plan: 'Só planeja; não altera nada até você aprovar',
  auto: 'Trabalha sozinho, pausando só em ações arriscadas',
};
export const MODE_ORDER: Mode[] = ['acceptEdits', 'default', 'plan', 'auto'];

export const EFFORT_LABEL: Record<Effort, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
export const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
