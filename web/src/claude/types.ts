/** Modelo de eventos da conversa: o que a tela renderiza. Derivado das mensagens do Agent SDK pelo mapper. */
/**
 * `'waiting'`: tool_use com pedido de permissão pendente ligado a ele (ver `applyPendingToolWaitStatus`
 * em mapper.ts) — nunca vem direto de `reduceSdkMessages` (que só conhece 'running' assim que o SDK
 * manda o tool_use); é uma correção aplicada depois, em `toConvEvents` (live.ts), a partir do
 * `toolUseId` real do SDK repassado por server/claude/runner.ts.
 */
export type ToolStatus = 'running' | 'waiting' | 'success' | 'failure' | 'warning';

export type AskOption = { label: string; description?: string };
export type AskQuestion = { header?: string; question: string; multiSelect?: boolean; options: AskOption[] };

/**
 * Anexo de uma mensagem do usuário, como a tela o exibe. `path` (novo, 28/09/2026 — popup de
 * imagem/Lightbox, ver PARIDADE.md): caminho absoluto no servidor do arquivo já salvo pelo endpoint
 * de upload (nunca apagado depois de enviado) — junto com `media_type`, alimenta
 * `attachmentImageUrl` (mapper.ts), que monta a URL de `GET /api/claude/attachments` pra buscar a
 * imagem de volta e mostrar a miniatura clicável no histórico (Timeline.tsx). Ausente em anexos
 * persistidos ANTES desta rodada, ou em anexos não-imagem — nesse caso a tela cai pro chip só com
 * ícone/nome de sempre, sem link. Os bytes em si nunca trafegam por aqui; só o suficiente pra montar
 * a URL de busca.
 */
export type UserAttachment = { kind: 'image' | 'file'; name: string; media_type?: string; path?: string };

export type ConvEvent =
  | { id: string; kind: 'user'; text: string; attachments?: UserAttachment[] }
  /**
   * `interrupted`: rótulo amigável ("Interrompido"/"Ferramenta interrompida") quando este texto é o
   * que restou de uma resposta cortada por um stop manual (botão Parar) — distinto de erro: renderiza
   * em estilo neutro/aviso, não vermelho (ver Timeline.tsx `.cc-interrupted`, mapper.ts `interruptedLabel`).
   * Ausente/undefined no caso normal (texto completo, sem interrupção).
   */
  | { id: string; kind: 'text'; text: string; streaming?: boolean; interrupted?: string }
  /** `durationMs`: quanto tempo o modelo pensou (distância entre a mensagem anterior e esta — ver reduceSdkMessages); só existe quando as mensagens têm `_when`. */
  | { id: string; kind: 'thinking'; text: string; streaming?: boolean; durationMs?: number }
  | {
      id: string; kind: 'tool'; toolUseId: string; name: string; label: string; description?: string;
      input: unknown; inputText?: string; output?: string; isError?: boolean; status: ToolStatus;
    }
  | {
      id: string; kind: 'permission'; toolUseId: string; name: string; label: string; description: string; inputText: string; questions?: AskQuestion[];
      decision?: 'allow' | 'allow_always' | 'deny' | 'answer' | 'timeout'; answer?: string;
      /** Quando >1: este bubble representa N pedidos expirados consecutivos, colapsados num só (ver foldExpiredPermissions). */
      expiredGroupCount?: number;
    }
  | { id: string; kind: 'result'; ok: boolean; durationMs?: number; turns?: number; inputTokens?: number; outputTokens?: number; error?: string }
  | { id: string; kind: 'system'; text: string }
  /**
   * Prompt REJEITADO por um hook UserPromptSubmit (exit 2): o SDK manda `system` com
   * `prevent_continuation: true` e o `result` vem "success" com 0 turnos — o Claude nunca viu a
   * mensagem. Sem este evento ela sumia em silêncio (incidente 2026-09-29, claude-mem "worker
   * unreachable for 3 consecutive hooks"). `prompt`/`attachments` são os do bubble anterior,
   * pro botão Reenviar da Timeline.
   */
  | { id: string; kind: 'blocked'; reason: string; prompt: string; attachments?: UserAttachment[] }
  /**
   * Indicador "pensando" ao vivo (ícone + palavra pulsando/trocando) — sintético, nunca persistido;
   * gerado só em `toConvEvents` (live.ts) quando `status==='running'` (turno rodando, sem pedido de
   * permissão pendente — mesma condição de `visiblyBusy && !permissionRequests.length` da extensão
   * real). Ver `ThinkingIndicator` em Timeline.tsx e a lista/timing em mapper.ts (`SPINNER_WORDS` etc.).
   */
  | { id: string; kind: 'busy' };

/** Subconjunto das mensagens do Agent SDK que o mapper entende. */
export type SdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | { type: 'text'; text: string }[]; is_error?: boolean };

export type SdkMessage =
  | { type: 'system'; subtype: 'init'; session_id?: string; model?: string; cwd?: string }
  | { type: 'system'; subtype: string; [k: string]: unknown }
  /**
   * `parent_tool_use_id` (29/09/2026, tool calls aninhadas por subagente — ver PARIDADE-agentmap.md):
   * campo REAL do SDK (`SDKAssistantMessage.parent_tool_use_id` em `@anthropic-ai/claude-agent-sdk/
   * sdk.d.ts`) — `null` em mensagens do agente principal; o `tool_use.id` da tool `Task` pai quando a
   * mensagem pertence ao transcript de um SUBAGENTE. O runner do Orion sempre persistiu a mensagem
   * inteira (`appendEvent(id, m.type, m)`), então o campo já chegava ao front — só ninguém lia.
   * Quem consome: `reduceSdkMessages` (pula mensagens de subagente da timeline principal) e
   * `noteAgentTask` (agrupa as tool calls do subagente em `AgentTask.toolCalls`), ambos em mapper.ts.
   */
  | { type: 'assistant'; message: { content: SdkContentBlock[] }; parent_tool_use_id?: string | null }
  /**
   * `tool_use_result` (opcional, 28/09/2026 — Mapa de agentes, ver mapper.ts `parseAgentTaskUsage`/
   * PARIDADE.md): campo real e documentado do SDK (`SDKUserMessage.tool_use_result` em
   * `@anthropic-ai/claude-agent-sdk/sdk.d.ts`) — "Structured tool output — the tool's full Output
   * object, not the string content sent to the model... For the Agent/Task tool the completed shape
   * is the subagent's final report... plus run totals — render from it instead of parsing the
   * tool_result text". `unknown` de propósito (o SDK também documenta assim: forma por-tool, MCP e
   * tools dinâmicas têm forma própria) — lido de forma defensiva, nunca assumido.
   */
  | { type: 'user'; message: { content: string | SdkContentBlock[]; attachments?: UserAttachment[] }; tool_use_result?: unknown; parent_tool_use_id?: string | null }
  | { type: 'result'; subtype: string; is_error?: boolean; duration_ms?: number; num_turns?: number; result?: string; modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: 'stream_event'; event: unknown };

/**
 * Telemetria real (quando o SDK a populou) de um subagente `Task` já concluído — nunca estimada.
 * Fonte: `tool_use_result` (ver `SdkMessage`/`parseAgentTaskUsage` acima) no formato `AgentOutput`
 * (`@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`, branch `status:"completed"`):
 * `totalTokens`/`totalToolUseCount`/`totalDurationMs`. Não confirmado ao vivo em produção nesta
 * rodada (ver PARIDADE.md, "Mapa de agentes" — lacuna de verificação documentada); qualquer campo
 * ausente na fonte real fica `undefined` aqui, nunca um número inventado.
 */
export type AgentTaskUsage = { totalTokens?: number; toolUses?: number; durationMs?: number };

/**
 * Uma tool call DE DENTRO de um subagente (mensagem do SDK com `parent_tool_use_id` = o `Task` pai)
 * — alimenta a lista aninhada `innerCallList` ao expandir a linha de um subagente no mapa/timeline
 * (29/09/2026, ver PARIDADE-agentmap.md; classes reais `innerCall/innerCallHeader/innerCallList/
 * innerCallSpinner/innerCallComplete/innerCallError` no webview v2.1.283). `label`/`description` já
 * vêm prontos de `describeTool` (mesmo cabeçalho que a tool teria na timeline principal); `status`
 * segue o mesmo ciclo do bloco de ferramenta comum: `running` no tool_use, fechado pelo tool_result
 * casado, `waiting` só como correção de view quando há permissão pendente pra ELA (ver
 * `applyPendingToAgentTasks` em mapper.ts — nunca persistido).
 */
export type AgentToolCall = { toolUseId: string; name: string; label: string; description?: string; status: ToolStatus };

/**
 * Um subagente (`tool_use` da tool `Task`) disparado nesta sessão, pro "Mapa de agentes"
 * (AgentMap.tsx). `startedAt`/`endedAt` são epoch ms: vêm do `ts` REAL de `claude_events` quando
 * reconstruído de linhas já persistidas (`fromRows`, ver live.ts) — coluna que já existe e já é
 * devolvida por `GET /api/claude/sessions/:id`, nenhuma mudança de backend precisou — ou, pra
 * eventos que chegam ao vivo pelo SSE (que não carregam timestamp de servidor), o instante em que o
 * navegador observou o evento (`applyLive`, parâmetro `now` injetável). `usage`: só populado quando o
 * SDK realmente mandou `tool_use_result` com totais — ausente na maioria dos casos hoje (ver
 * PARIDADE.md); a duração ainda é mostrada nesse caso via `startedAt`/`endedAt`.
 */
export type AgentTask = {
  toolUseId: string;
  description: string;
  subagentType?: string;
  status: ToolStatus;
  startedAt?: number;
  endedAt?: number;
  usage?: AgentTaskUsage;
  /** Tool calls do próprio subagente, na ordem em que chegaram (ver `AgentToolCall` acima) — ausente
   * quando o SDK não entregou nenhuma mensagem com `parent_tool_use_id` deste Task (ex.: histórico
   * antigo, ou subagente que ainda não chamou ferramenta nenhuma). */
  toolCalls?: AgentToolCall[];
};

/** Comando de barra real da sessão (server/claude/runner.ts, via Query.supportedCommands() do SDK) — nome, descrição e dica de argumento, iguais ao que a extensão real lista no menu `/`. */
export type SlashCommandInfo = { name: string; description: string; argumentHint?: string };

export type SessionStatus = 'running' | 'waiting' | 'idle' | 'unread' | 'failed';

/**
 * Uma pasta nomeada de sessões — "Agrupamento de sessões em pastas nomeadas" (ver PARIDADE.md,
 * item 12 da seção 13: classes `newGroupButton`/`groupHeader`/`groupChevron`/`groupName`/
 * `groupCount` da extensão real). Diferente do "Agrupar por Nenhum/Projeto/Atividade" já existente
 * (`GroupBy`/`groupSessions`, mais abaixo em mapper.ts) — aquele é automático e nunca persistido
 * (`useState` local, reseta a cada reload); isto aqui é criado à mão pelo usuário e sobrevive a
 * reload/troca de aba (tabela `claude_session_groups` no Postgres, migração `010_claude_session_groups`
 * em server/migrations.ts). `createdAt`: epoch ms, só usado pra ordenar as pastas na ordem em que
 * foram criadas (sem reordenação manual nesta rodada — ver PARIDADE.md, decisão de escopo).
 */
export type SessionGroupInfo = { id: string; name: string; createdAt: number };

export type SessionSummary = {
  id: string; title: string; status: SessionStatus; updatedAt: number; group?: string; project?: string; projectName?: string; archived?: boolean;
  /** Nome do worktree desta sessão (derivado do `cwd`, ver `sessionWorktreeName` em mapper.ts) — `undefined` quando a sessão roda na raiz do projeto, sem worktree. Alimenta a pill em Sidebar.tsx. */
  worktreeName?: string;
  /**
   * Pasta nomeada (manual) a que esta sessão pertence — `claude_sessions.group_id`, `null`/`undefined`
   * quando a sessão está solta ("Sem pasta"). Alimenta `groupSessions(sessions, 'folder', now, folders)`
   * e o seletor "Mover para pasta" por sessão em Sidebar.tsx. Ver PARIDADE.md.
   */
  groupId?: string | null;
};

/**
 * Painel de skills + lista de hooks da "Aba Claude" (PARIDADE.md, seção 13, itens 10/11;
 * `SkillsHooksPanel.tsx`). Formas espelhando exatamente o que `server/claude/hooks.ts`/
 * `server/claude/skills.ts` devolvem — mesma convenção de `ApiSession` (duplicado, nunca
 * compartilhado de verdade com o servidor: não há pacote de tipos comum neste projeto).
 */
export type HookSourceKind = 'project' | 'local' | 'user';
export const HOOK_SOURCE_LABEL: Record<HookSourceKind, string> = { project: 'Projeto', local: 'Local', user: 'Usuário' };

export type HookEntry = {
  event: string; matcher: string; type: string; description: string;
  source: HookSourceKind; disabled: boolean; timeout?: number;
};
export type HookFileError = { source: HookSourceKind; file: string; message: string };
export type HookListing = { hooks: HookEntry[]; errors: HookFileError[]; disableAllHooks: boolean; loadedByOrion: HookSourceKind[] };

export type SkillSourceKind = 'project' | 'user' | 'synced';
export const SKILL_SOURCE_LABEL: Record<SkillSourceKind, string> = { project: 'Projeto', user: 'Usuário', synced: 'Sincronizada' };

export type SkillEntry = { name: string; description: string; source: SkillSourceKind; dir: string; enabled: boolean };
