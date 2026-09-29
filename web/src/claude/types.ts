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
  | { id: string; kind: 'thinking'; text: string; streaming?: boolean }
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
  | { id: string; kind: 'result'; ok: boolean; costUsd?: number; durationMs?: number; turns?: number; inputTokens?: number; outputTokens?: number; error?: string }
  | { id: string; kind: 'system'; text: string }
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
  | { type: 'assistant'; message: { content: SdkContentBlock[] } }
  /**
   * `tool_use_result` (opcional, 28/09/2026 — Mapa de agentes, ver mapper.ts `parseAgentTaskUsage`/
   * PARIDADE.md): campo real e documentado do SDK (`SDKUserMessage.tool_use_result` em
   * `@anthropic-ai/claude-agent-sdk/sdk.d.ts`) — "Structured tool output — the tool's full Output
   * object, not the string content sent to the model... For the Agent/Task tool the completed shape
   * is the subagent's final report... plus run totals — render from it instead of parsing the
   * tool_result text". `unknown` de propósito (o SDK também documenta assim: forma por-tool, MCP e
   * tools dinâmicas têm forma própria) — lido de forma defensiva, nunca assumido.
   */
  | { type: 'user'; message: { content: string | SdkContentBlock[]; attachments?: UserAttachment[] }; tool_use_result?: unknown }
  | { type: 'result'; subtype: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; num_turns?: number; result?: string; modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>; usage?: { input_tokens?: number; output_tokens?: number } }
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
};

/** Comando de barra real da sessão (server/claude/runner.ts, via Query.supportedCommands() do SDK) — nome, descrição e dica de argumento, iguais ao que a extensão real lista no menu `/`. */
export type SlashCommandInfo = { name: string; description: string; argumentHint?: string };

export type SessionStatus = 'running' | 'waiting' | 'idle' | 'unread' | 'failed';

export type SessionSummary = {
  id: string; title: string; status: SessionStatus; updatedAt: number; group?: string; project?: string; projectName?: string; archived?: boolean;
  /** Nome do worktree desta sessão (derivado do `cwd`, ver `sessionWorktreeName` em mapper.ts) — `undefined` quando a sessão roda na raiz do projeto, sem worktree. Alimenta a pill em Sidebar.tsx. */
  worktreeName?: string;
};
