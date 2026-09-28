/** Modelo de eventos da conversa: o que a tela renderiza. Derivado das mensagens do Agent SDK pelo mapper. */
export type ToolStatus = 'running' | 'success' | 'failure' | 'warning';

export type AskOption = { label: string; description?: string };
export type AskQuestion = { header?: string; question: string; multiSelect?: boolean; options: AskOption[] };

/** Anexo de uma mensagem do usuário, como a tela o exibe (só metadados; os bytes ficam no servidor). */
export type UserAttachment = { kind: 'image' | 'file'; name: string; media_type?: string };

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
  | { id: string; kind: 'system'; text: string };

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
  | { type: 'user'; message: { content: string | SdkContentBlock[]; attachments?: UserAttachment[] } }
  | { type: 'result'; subtype: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; num_turns?: number; result?: string; modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: 'stream_event'; event: unknown };

/** Comando de barra real da sessão (server/claude/runner.ts, via Query.supportedCommands() do SDK) — nome, descrição e dica de argumento, iguais ao que a extensão real lista no menu `/`. */
export type SlashCommandInfo = { name: string; description: string; argumentHint?: string };

export type SessionStatus = 'running' | 'waiting' | 'idle' | 'unread' | 'failed';

export type SessionSummary = {
  id: string; title: string; status: SessionStatus; updatedAt: number; group?: string; project?: string; projectName?: string; archived?: boolean;
};
