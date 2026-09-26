import type { ConvEvent, SdkMessage } from './types';
import { describeTool, reduceSdkMessages } from './mapper';

export type LiveStatus = 'running' | 'waiting' | 'idle' | 'error';
export type PermReq = { id: string; toolName: string; input: Record<string, unknown>; hasSuggestions: boolean; decision?: string };
export type LiveState = {
  status: LiveStatus; messages: SdkMessage[]; partialText: string; partialThinking: string;
  pending: PermReq[]; resolvedPerms: PermReq[]; error: string | null; lastPrompt: string | null;
};
export type Row = { seq: number; ts?: string; type: string; payload: any };

export const emptyLive = (): LiveState => ({ status: 'idle', messages: [], partialText: '', partialThinking: '', pending: [], resolvedPerms: [], error: null, lastPrompt: null });

const ATTACH_NOTE = '\n\n[arquivo anexado:';

/** Texto de uma mensagem de usuário (string, ou junção dos blocos de texto). tool_result puro → undefined. */
function userText(m: Extract<SdkMessage, { type: 'user' }>): string | undefined {
  const c = m.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
    return t.length ? t : undefined;
  }
  return undefined;
}

function pushMessage(s: LiveState, m: SdkMessage): LiveState {
  // O runner ecoa o prompt como mensagem 'user'; se o SDK ecoar de novo (mesmo texto, ou texto +
  // as notas de arquivo anexo), ignora a duplicata. tool_result (sem texto) nunca é tratado como eco.
  if (m.type === 'user') {
    const t = userText(m);
    if (t !== undefined) {
      if (s.lastPrompt !== null && (t === s.lastPrompt || (t.startsWith(s.lastPrompt) && t.slice(s.lastPrompt.length).startsWith(ATTACH_NOTE)))) return s;
      return { ...s, messages: [...s.messages, m], lastPrompt: t, partialText: '', partialThinking: '' };
    }
  }
  const clear = m.type === 'assistant' || m.type === 'result';
  return { ...s, messages: [...s.messages, m], partialText: clear ? '' : s.partialText, partialThinking: clear ? '' : s.partialThinking };
}

/** Reconstrói o estado a partir das linhas persistidas + verdade do servidor sobre pendências. */
export function fromRows(rows: Row[], status: LiveStatus, pendingIds: { id: string; toolName: string }[]): LiveState {
  let s = emptyLive();
  const reqs = new Map<string, PermReq>();
  for (const r of rows) {
    const p = r.payload ?? {};
    switch (r.type) {
      case 'user_prompt': s = pushMessage(s, { type: 'user', message: { content: String(p.prompt ?? ''), attachments: Array.isArray(p.attachments) ? p.attachments : undefined } }); break;
      case 'system': case 'assistant': case 'user': case 'result': s = pushMessage(s, p as SdkMessage); break;
      case 'permission_request': reqs.set(p.id, { id: p.id, toolName: p.toolName, input: p.input ?? {}, hasSuggestions: false }); break;
      case 'permission_resolved': { const q = reqs.get(p.id); if (q) q.decision = p.decision; break; }
      case 'error': s = { ...s, error: String(p.message ?? 'erro') }; break;
    }
  }
  const pendingSet = new Set(pendingIds.map(x => x.id));
  const pending = [...reqs.values()].filter(q => pendingSet.has(q.id));
  for (const x of pendingIds) if (!reqs.has(x.id)) pending.push({ id: x.id, toolName: x.toolName, input: {}, hasSuggestions: false });
  // pedidos que não estão mais pendentes e nunca foram resolvidos: marca como expirados (não somem)
  const resolved: PermReq[] = [...reqs.values()].filter(q => !pendingSet.has(q.id) && q.decision).map(q => ({ ...q }));
  const expirados: PermReq[] = [...reqs.values()].filter(q => !pendingSet.has(q.id) && !q.decision).map(q => ({ ...q, decision: 'timeout' }));
  return { ...s, status, pending, resolvedPerms: [...resolved, ...expirados], error: status === 'error' ? s.error : null };
}

/** Aplica um evento do stream (SSE). Pura. */
export function applyLive(s: LiveState, ev: any): LiveState {
  switch (ev?.type) {
    case 'hello': {
      const known = new Map(s.pending.map(p => [p.id, p]));
      const pending = (ev.pending ?? []).map((x: any) => known.get(x.id) ?? { id: x.id, toolName: x.toolName, input: {}, hasSuggestions: false });
      return { ...s, status: ev.status ?? s.status, pending };
    }
    case 'status': return { ...s, status: ev.status, error: ev.status === 'running' ? null : s.error };
    case 'message': return pushMessage(s, ev.message);
    case 'partial': {
      const e = ev.event ?? {};
      if (e.type === 'message_start') return { ...s, partialText: '', partialThinking: '' };
      if (e.type === 'content_block_start') {
        const t = e.content_block?.type;
        if (t === 'text') return { ...s, partialText: '' };
        if (t === 'thinking') return { ...s, partialThinking: '' };
        return s;
      }
      if (e.type === 'content_block_delta') {
        const d = e.delta ?? {};
        if (d.type === 'text_delta') return { ...s, partialText: s.partialText + (d.text ?? '') };
        if (d.type === 'thinking_delta') return { ...s, partialThinking: s.partialThinking + (d.thinking ?? '') };
      }
      return s;
    }
    case 'permission_request':
      if (s.pending.some(p => p.id === ev.id)) return s;
      return { ...s, status: 'waiting', pending: [...s.pending, { id: ev.id, toolName: ev.toolName, input: ev.input ?? {}, hasSuggestions: !!ev.hasSuggestions }] };
    case 'permission_resolved': return { ...s, pending: s.pending.filter(p => p.id !== ev.id) };
    case 'error': return { ...s, error: String(ev.message ?? 'erro'), partialText: '', partialThinking: '' };
    case 'turn_end': return { ...s, partialText: '', partialThinking: '' };
    default: return s;
  }
}

/** O que a linha do tempo renderiza: mensagens reduzidas + parciais + pendências + erro. */
export function toConvEvents(s: LiveState): ConvEvent[] {
  const out = reduceSdkMessages(s.messages);
  if (s.partialThinking) out.push({ id: 'partial-thinking', kind: 'thinking', text: s.partialThinking, streaming: true });
  if (s.partialText) out.push({ id: 'partial-text', kind: 'text', text: s.partialText, streaming: true });
  const parseQuestions = (input: Record<string, unknown>) => Array.isArray((input as any)?.questions) ? (input as any).questions : undefined;
  for (const p of [...s.resolvedPerms, ...s.pending]) {
    const d = describeTool(p.toolName, p.input);
    const isAsk = p.toolName === 'AskUserQuestion';
    out.push({ id: p.id, kind: 'permission', toolUseId: p.id, name: p.toolName, label: d.label, description: d.description ?? '', inputText: d.inputText ?? JSON.stringify(p.input, null, 2), questions: isAsk ? parseQuestions(p.input) : undefined, decision: p.decision as any });
  }
  if (s.error && s.status === 'error') out.push({ id: 'live-error', kind: 'result', ok: false, error: s.error });
  return out;
}
