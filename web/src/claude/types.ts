/** Modelo de eventos da conversa: o que a tela renderiza. Derivado das mensagens do Agent SDK pelo mapper. */
export type ToolStatus = 'running' | 'success' | 'failure' | 'warning';

export type AskOption = { label: string; description?: string };
export type AskQuestion = { header?: string; question: string; multiSelect?: boolean; options: AskOption[] };

export type ConvEvent =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'text'; text: string; streaming?: boolean }
  | { id: string; kind: 'thinking'; text: string; streaming?: boolean }
  | {
      id: string; kind: 'tool'; toolUseId: string; name: string; label: string; description?: string;
      input: unknown; inputText?: string; output?: string; isError?: boolean; status: ToolStatus;
    }
  | { id: string; kind: 'permission'; toolUseId: string; name: string; label: string; description: string; inputText: string; questions?: AskQuestion[]; decision?: 'allow' | 'allow_always' | 'deny' | 'answer' | 'timeout'; answer?: string }
  | { id: string; kind: 'result'; ok: boolean; costUsd?: number; durationMs?: number; turns?: number; error?: string }
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
  | { type: 'user'; message: { content: string | SdkContentBlock[] } }
  | { type: 'result'; subtype: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; num_turns?: number; result?: string }
  | { type: 'stream_event'; event: unknown };

export type SessionStatus = 'running' | 'waiting' | 'idle' | 'unread' | 'failed';

export type SessionSummary = {
  id: string; title: string; status: SessionStatus; updatedAt: number; group?: string; project?: string;
};
