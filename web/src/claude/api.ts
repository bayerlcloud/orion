import { api } from '../api';
import type { Row } from './live';
import type { RealUsage } from './mapper';
import type { HookListing, SkillEntry } from './types';

export type ApiSession = {
  id: string; title: string; status: 'running' | 'waiting' | 'idle' | 'error'; input_tokens: number | string; output_tokens: number | string; turns: number; model: string | null;
  permission_mode: string; effort: string | null; cwd: string; last_error: string | null; archived?: boolean; created_at: string; updated_at: string;
  user_id: number; user_name: string; project_slug: string | null; project_name: string | null; pending: number;
  /** Pasta nomeada manual desta sessão (`claude_sessions.group_id`) — `null` quando está solta ("Sem pasta"). Ver PARIDADE.md item 12 da seção 13. */
  group_id: string | null;
  /** Output style da sessão (`claude_sessions.output_style`, nullable = sem estilo) — só vem no GET
   * de UMA sessão (`SELECT s.*`), não na listagem; ver PARIDADE-marketplace.md. */
  output_style?: string | null;
};
export type Project = { id: number; slug: string; name: string; path: string; rules: string | null };
/** Pasta nomeada manual de sessões (`GET /api/claude/session-groups`) — ver PARIDADE.md item 12 da seção 13. */
export type ApiSessionGroup = { id: string; name: string; created_at: string };
export type Mode = 'acceptEdits' | 'default' | 'plan' | 'auto';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * Escolha do seletor de esforço: os 5 níveis reais do SDK ou o degrau extra "Ultracode" — um nível
 * ACIMA de max no mesmo seletor, paridade com a extensão real v2.1.283 (`IV0="Ultracode"`,
 * `fe = "Ultracode - xhigh + workflows"`, `enableUltracode()`; ver PARIDADE-seletor.md). O valor de
 * fio 'ultracode' vai como está pro servidor (rotas aceitam e persistem em `claude_sessions.effort`);
 * a tradução pro SDK (xhigh + instrução de orquestração) é toda do server/claude/ultracode.ts.
 */
export type EffortChoice = Effort | 'ultracode';
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
  usage: () => api<{ usage: { id: number; name: string; tokens_5h: string; tokens_7d: string; tokens_total: string; sessions: string }[]; real: RealUsage; by_model?: { model: string | null; tokens: string }[] }>('/api/claude/usage'),
  /** `worktree_name`: cria um git worktree novo (branch `feature/<nome>`) e a sessão já nasce com `cwd` apontando pra ele — ver PARIDADE.md seção 14. Ausente/vazio = sessão normal na raiz do projeto, como sempre foi. */
  create: (b: { project_id: number | null; prompt: string; permission_mode: Mode; model?: string; effort?: EffortChoice; attachments?: Attachment[]; worktree_name?: string }) => api<{ id: string; title: string }>('/api/claude/sessions', { method: 'POST', body: JSON.stringify(b) }),
  get: (id: string) => api<{ session: ApiSession; events: Row[]; pending: { id: string; toolName: string }[] }>(`/api/claude/sessions/${id}`),
  send: (id: string, b: { prompt: string; permission_mode?: Mode; model?: string; effort?: EffortChoice; attachments?: Attachment[] }) => api<{ ok: true; queued: boolean }>(`/api/claude/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify(b) }),
  // Upload multipart: não passa pelo helper `api` (que forçaria Content-Type JSON); o navegador define o boundary.
  drafts: () => api<{ drafts: Record<string, { text: string; attachments: Attachment[] }> }>('/api/claude/drafts'),
  saveDraft: (id: string, text: string, attachments: Attachment[]) => api<{ ok: true }>(`/api/claude/drafts/${id}`, { method: 'PUT', body: JSON.stringify({ text, attachments }) }),
  transcribe: async (audio: Blob, filename: string): Promise<{ text: string; engine: string }> => {
    const fd = new FormData();
    fd.append('file', audio, filename);
    const res = await fetch('/api/claude/transcribe', { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error ?? `erro ${res.status}`);
    return data as { text: string; engine: string };
  },
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
  setEffort: (id: string, effort: EffortChoice) => api<{ ok: true; live: boolean }>(`/api/claude/sessions/${id}/effort`, { method: 'POST', body: JSON.stringify({ effort }) }),
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
  /**
   * "Aba Claude" — agrupamento de sessões em pastas nomeadas (ver PARIDADE.md item 12 da seção 13).
   * Compartilhadas entre todos os usuários (mesmo modelo de `sessions()`, sem filtro por dono).
   */
  sessionGroups: () => api<{ groups: ApiSessionGroup[] }>('/api/claude/session-groups'),
  createGroup: (name: string) => api<{ id: string; name: string }>('/api/claude/session-groups', { method: 'POST', body: JSON.stringify({ name }) }),
  renameGroup: (id: string, name: string) => api<{ ok: true }>(`/api/claude/session-groups/${id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }),
  /** Apaga a pasta; as sessões que estavam nela voltam pro nível raiz ("Sem pasta") — nunca são apagadas junto. */
  deleteGroup: (id: string) => api<{ ok: true }>(`/api/claude/session-groups/${id}`, { method: 'DELETE' }),
  /** `groupId: null` solta a sessão de volta pro nível raiz. Alternativa a drag-and-drop (menu/dropdown "Mover para pasta" por sessão — ver Sidebar.tsx e PARIDADE.md). */
  moveToGroup: (sessionId: string, groupId: string | null) => api<{ ok: true }>(`/api/claude/sessions/${sessionId}/group`, { method: 'POST', body: JSON.stringify({ group_id: groupId }) }),
  /**
   * "Aba Claude" — marketplace de plugins/MCP + output styles (ver Marketplace.tsx, OutputStyles.tsx
   * e PARIDADE-marketplace.md). Plugins do catálogo com estado POR PESSOA (chave plugin:<nome> em
   * skill_prefs); mutações de catálogo/marketplace são só do admin (o servidor barra, a UI esconde).
   */
  marketplacePlugins: () => api<{ plugins: CatalogPlugin[]; catalogo_dir: string }>('/api/claude/marketplace/plugins'),
  setPluginEnabled: (nome: string, escopo: 'eu' | 'todos', ligada: boolean | null) =>
    api<{ ok: true; todos: boolean | null; eu: boolean | null; efetiva: boolean }>(`/api/claude/marketplace/plugins/${encodeURIComponent(nome)}`, { method: 'PUT', body: JSON.stringify({ escopo, ligada }) }),
  marketplaces: () => api<{ marketplaces: MarketplaceInfo[] }>('/api/claude/marketplace/marketplaces'),
  addMarketplace: (source: string) => api<{ ok: true }>('/api/claude/marketplace/marketplaces', { method: 'POST', body: JSON.stringify({ source }) }),
  removeMarketplace: (nome: string) => api<{ ok: true }>(`/api/claude/marketplace/marketplaces/${encodeURIComponent(nome)}`, { method: 'DELETE' }),
  refreshMarketplace: (nome: string) => api<{ ok: true }>(`/api/claude/marketplace/marketplaces/${encodeURIComponent(nome)}/refresh`, { method: 'POST' }),
  installPlugin: (plugin: string, marketplace: string) => api<{ ok: true; destino: string }>('/api/claude/marketplace/install', { method: 'POST', body: JSON.stringify({ plugin, marketplace }) }),
  mcpServers: () => api<{ servers: McpServerInfo[] }>('/api/claude/marketplace/mcp'),
  /** Estilos de saída: embutidos do CLI + customs do catálogo (/srv/claude/catalog/output-styles). */
  outputStyles: () => api<{ styles: OutputStyleInfo[] }>('/api/claude/output-styles'),
  createOutputStyle: (b: { nome: string; descricao: string; instrucoes: string; manter_instrucoes_codigo: boolean; substituir?: boolean }) =>
    api<{ ok: true; slug: string }>('/api/claude/output-styles', { method: 'POST', body: JSON.stringify(b) }),
  /** Mesmo contrato de setMode/setModel/setEffort: persiste primeiro, aplica ao vivo se há Query rodando. 'default' = sem estilo. */
  setOutputStyle: (id: string, style: string) => api<{ ok: true; live: boolean }>(`/api/claude/sessions/${id}/output-style`, { method: 'POST', body: JSON.stringify({ style }) }),
};

/** Plugin do catálogo (/srv/claude/catalog/plugins/<nome>) com o estado por pessoa. */
export type CatalogPlugin = {
  nome: string; descricao: string; versao: string | null; autor: string | null; hooks: boolean;
  skills: number; commands: number; agents: number;
  ligada_todos: boolean | null; ligada_eu: boolean | null; efetiva: boolean;
};
export type MarketplaceInfo = {
  nome: string; fonte: string; fonte_url: string | null; oficial: boolean; atualizado: string | null; descricao: string;
  plugins: { name: string; description: string; category: string | null; instalado: boolean }[];
};
export type McpServerInfo = { nome: string; tipo: string; detalhe: string; origem: string; escopo: string };
export type OutputStyleInfo = { nome: string; label: string; descricao: string; builtin: boolean; criado_por: string | null };

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
/** Rótulo curto do degrau Ultracode no pill (extensão real: `kV0` devolve `IV0`="Ultracode" quando selecionado). */
export const ULTRACODE_LABEL = 'Ultracode';
/** String literal EXATA da extensão real (`fe = IV0 + " - xhigh + workflows"`) — rótulo do degrau no menu/slider. */
export const ULTRACODE_MENU_LABEL = 'Ultracode - xhigh + workflows';
/** Rótulo do pill/tooltip pra qualquer escolha do seletor, incluindo o degrau Ultracode. */
export function effortPillLabel(e: EffortChoice): string {
  return e === 'ultracode' ? ULTRACODE_LABEL : EFFORT_LABEL[e];
}

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
export function matchEffort(effort: string | null | undefined): EffortChoice {
  if (effort === 'ultracode') return 'ultracode'; // degrau extra persistido como está (ver EffortChoice)
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
