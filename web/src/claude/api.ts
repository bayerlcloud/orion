import { api } from '../api';
import type { Row } from './live';
import type { RealUsage } from './mapper';
import type { HookListing, SkillEntry } from './types';

export type ApiSession = {
  id: string; title: string; status: 'running' | 'waiting' | 'idle' | 'error'; cost_usd: number; turns: number; model: string | null;
  permission_mode: string; effort: string | null; cwd: string; last_error: string | null; archived?: boolean; created_at: string; updated_at: string;
  user_name: string; project_slug: string | null; project_name: string | null; pending: number;
};
export type Project = { id: number; slug: string; name: string; path: string; rules: string | null };
export type Mode = 'acceptEdits' | 'default' | 'plan' | 'auto';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Me = { id: number; name: string; email: string; role: string };
/** Anexo já salvo no servidor pelo endpoint de upload. */
export type Attachment = { kind: 'image' | 'file'; media_type: string; name: string; path: string; size?: number };

/**
 * Editor de regras de permissão (allow/deny/ask) — ver `server/claude/permissionRules.ts` (decisão de
 * arquitetura completa) e PARIDADE.md item 9 da seção 13. `'user'`: `~/.claude/settings.json` do login
 * único que roda o servidor na c3 (global — afeta TODOS os projetos/usuários do Orion). `'project'`:
 * `<project.path>/.claude/settings.json` do projeto escolhido. Nunca `'local'`
 * (`.claude/settings.local.json`) — o `Runner` não lê esse arquivo hoje (`settingSources: ['user',
 * 'project']`), então uma regra salva lá nunca teria efeito; por isso nem é oferecido na UI.
 */
export type PermissionBehavior = 'allow' | 'ask' | 'deny';
export type PermissionScope = 'user' | 'project';
export type PermissionRuleSet = { allow: string[]; ask: string[]; deny: string[] };

export const claudeApi = {
  status: () => api<{ logged_in: boolean; home: string; version: string; linux_user: string | null }>('/api/claude/status'),
  me: () => api<{ user: Me }>('/api/me'),
  projects: () => api<{ projects: Project[] }>('/api/claude/projects'),
  sessions: () => api<{ sessions: ApiSession[] }>('/api/claude/sessions'),
  uiState: () => api<{ tabs: string[]; active_id: string | null }>('/api/claude/ui-state'),
  saveUiState: (b: { tabs: string[]; active_id: string | null; client?: string }) => api<{ ok: true }>('/api/claude/ui-state', { method: 'PUT', body: JSON.stringify(b) }),
  usage: () => api<{ usage: { id: number; name: string; cost_5h: string; cost_7d: string; cost_total: string; sessions: string }[]; real: RealUsage }>('/api/claude/usage'),
  /** `worktree_name`: cria um git worktree novo (branch `feature/<nome>`) e a sessão já nasce com `cwd` apontando pra ele — ver PARIDADE.md seção 14. Ausente/vazio = sessão normal na raiz do projeto, como sempre foi. */
  create: (b: { project_id: number; prompt: string; permission_mode: Mode; model?: string; effort?: Effort; attachments?: Attachment[]; worktree_name?: string }) => api<{ id: string; title: string }>('/api/claude/sessions', { method: 'POST', body: JSON.stringify(b) }),
  get: (id: string) => api<{ session: ApiSession; events: Row[]; pending: { id: string; toolName: string }[] }>(`/api/claude/sessions/${id}`),
  send: (id: string, b: { prompt: string; permission_mode?: Mode; model?: string; effort?: Effort; attachments?: Attachment[] }) => api<{ ok: true; queued: boolean }>(`/api/claude/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify(b) }),
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
  /**
   * Troca de modo/modelo/esforço AO VIVO (mid-turno) — bug real reportado pelo Bayerl ao vivo em
   * 28/09/2026 (ver PARIDADE.md): antes, `onMode`/`onModel`/`onEffort` em `ClaudePage.tsx` só
   * atualizavam `useState` local; o valor novo só era mandado ao servidor no PRÓXIMO create/send, sem
   * nenhum efeito num turno já em andamento (a extensão real aplica na hora, via control methods do
   * SDK — `Query.setPermissionMode`/`setModel`/`applyFlagSettings`). `live` na resposta indica se
   * havia uma Query rodando agora pra aplicar de verdade (sessão ociosa entre turnos: `false`, mas o
   * valor já foi persistido/vai junto no próximo turno de qualquer forma).
   */
  setMode: (id: string, mode: Mode) => api<{ ok: true; live: boolean }>(`/api/claude/sessions/${id}/mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
  /** `model` omitido/vazio = "sem override" (volta pro modelo padrão da sessão/conta ao vivo, sem mexer no que já está persistido — mesma semântica de `send`). */
  setModel: (id: string, model?: string) => api<{ ok: true; live: boolean }>(`/api/claude/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) }),
  /** Esforço nunca é persistido por sessão (sempre reenviado em create/send) — esta chamada só tem o lado ao vivo. */
  setEffort: (id: string, effort: Effort) => api<{ ok: true; live: boolean }>(`/api/claude/sessions/${id}/effort`, { method: 'POST', body: JSON.stringify({ effort }) }),
  stop: (id: string) => api<{ ok: true }>(`/api/claude/sessions/${id}/stop`, { method: 'POST' }),
  rename: (id: string, title: string) => api<{ ok: true }>(`/api/claude/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) }),
  archive: (id: string, archived: boolean) => api<{ ok: true; archived: boolean }>(`/api/claude/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  remove: (id: string) => api<{ ok: true }>(`/api/claude/sessions/${id}`, { method: 'DELETE' }),
  /**
   * Painel de skills + lista de hooks (PARIDADE.md seção 13, itens 10/11; `SkillsHooksPanel.tsx`).
   * `hooks`: SÓ LEITURA (ver `server/claude/hooks.ts` pro porquê — risco real de um hook virar shell
   * arbitrário rodando sozinho pra todo mundo que usar o projeto depois, numa ferramenta
   * multi-usuário; sem canal de edição seguro equivalente ao da extensão real). `skills`: habilitar/
   * desabilitar é seguro (filtro de contexto do SDK, nunca escreve `settings.json`/roda comando).
   */
  hooks: (projectId: number) => api<HookListing>(`/api/claude/projects/${projectId}/hooks`),
  skills: (projectId: number) => api<{ skills: SkillEntry[] }>(`/api/claude/projects/${projectId}/skills`),
  setSkillEnabled: (projectId: number, name: string, enabled: boolean) =>
    api<{ ok: true }>(`/api/claude/projects/${projectId}/skills`, { method: 'POST', body: JSON.stringify({ name, enabled }) }),
  /** Lista as regras do escopo. `error` (opcional na resposta): settings.json existe mas tem JSON inválido — o servidor devolve 3 listas vazias + o motivo, em vez de travar a tela. */
  permissionRules: (scope: PermissionScope, projectId?: number) =>
    api<PermissionRuleSet & { error?: string }>(`/api/claude/permission-rules?scope=${scope}${projectId ? `&project_id=${projectId}` : ''}`),
  addPermissionRule: (b: { scope: PermissionScope; projectId?: number; behavior: PermissionBehavior; rule: string }) =>
    api<PermissionRuleSet>('/api/claude/permission-rules', { method: 'POST', body: JSON.stringify({ scope: b.scope, project_id: b.projectId, behavior: b.behavior, rule: b.rule }) }),
  /** "Editar" = trocar texto e/ou behavior numa escrita só (`replaceRule` no servidor: remove a antiga se ainda existir, adiciona a nova). */
  editPermissionRule: (b: { scope: PermissionScope; projectId?: number; oldBehavior: PermissionBehavior; oldRule: string; behavior: PermissionBehavior; rule: string }) =>
    api<PermissionRuleSet>('/api/claude/permission-rules', { method: 'PUT', body: JSON.stringify({ scope: b.scope, project_id: b.projectId, old_behavior: b.oldBehavior, old_rule: b.oldRule, behavior: b.behavior, rule: b.rule }) }),
  removePermissionRule: (b: { scope: PermissionScope; projectId?: number; behavior: PermissionBehavior; rule: string }) =>
    api<PermissionRuleSet>('/api/claude/permission-rules', { method: 'DELETE', body: JSON.stringify({ scope: b.scope, project_id: b.projectId, behavior: b.behavior, rule: b.rule }) }),
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

/**
 * Esforço válido a partir do valor persistido em `claude_sessions.effort` (coluna nova, nullable —
 * sessão sem escolha explícita de esforço, ou criada antes da coluna existir, tem `null`; ver
 * migração `009_claude_effort` em `server/migrations.ts`). Mesma ideia de `matchModelAlias` logo
 * abaixo: nunca confia cegamente no valor do banco, sempre resolve pra um `Effort` concreto e
 * válido. Sem essa resolução, reabrir uma sessão sem esforço persistido deixaria o `useState` do
 * composer com o valor "vazado" da sessão aberta anteriormente na mesma aba (o `setEffort` do
 * efeito de carga só faria sentido disparar quando há valor pra restaurar) — `'medium'` é o mesmo
 * padrão do `useState<Effort>('medium')` inicial em `ClaudePage.tsx`.
 */
export function matchEffort(effort: string | null | undefined): Effort {
  return (EFFORT_ORDER as string[]).includes(effort ?? '') ? (effort as Effort) : 'medium';
}

/**
 * Modelo escolhido no seletor do compositor. `'default'` = sem override (usa o padrão da sessão/
 * conta); os demais são os aliases reais que o Agent SDK aceita no campo `model` das `Options`
 * (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`: "Model alias (e.g. 'fable', 'opus',
 * 'sonnet', 'haiku') or full model ID"), os mesmos 4 literais (`"default"`, `"haiku"`, `"opus"`,
 * `"sonnet"`) achados soltos no webview decompilado da extensão real (v2.1.282) e "Fable 5" como
 * rótulo real visto lá também (`grep -oE '"(Sonnet|Opus|Haiku|Fable)[^"]{0,40}"'`). A extensão real
 * busca a lista completa ao vivo (`Query.supportedModels()`); aqui é uma lista estática por decisão
 * de escopo — o seletor precisa funcionar mesmo numa sessão ainda não iniciada (rascunho), quando
 * não existe Query nenhuma pra perguntar (ver PARIDADE.md, seção 5).
 */
export type ModelAlias = 'default' | 'sonnet' | 'opus' | 'haiku' | 'fable';
export const MODEL_LABEL: Record<ModelAlias, string> = { default: 'Padrão', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', fable: 'Fable' };
export const MODEL_ORDER: ModelAlias[] = ['default', 'sonnet', 'opus', 'haiku', 'fable'];

/**
 * Alias do menu que corresponde ao `model` resolvido de uma sessão (`system/init` grava o id
 * canônico, ex. "claude-sonnet-5", "claude-fable-5-1" — nunca o alias curto). Casamento por
 * substring (case-insensitive) contra cada alias conhecido; sem match ou sem modelo, `'default'`.
 */
export function matchModelAlias(model: string | null | undefined): ModelAlias {
  if (!model) return 'default';
  const m = model.toLowerCase();
  for (const alias of MODEL_ORDER) if (alias !== 'default' && m.includes(alias)) return alias;
  return 'default';
}
