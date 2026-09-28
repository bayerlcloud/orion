import type { ConvEvent, SdkMessage, SlashCommandInfo } from './types';
import { applyPendingToolWaitStatus, describeTool, interruptedLabel, reduceSdkMessages } from './mapper';

export type LiveStatus = 'running' | 'waiting' | 'idle' | 'error';
/** `toolUseId`: id real do SDK pro tool_use que gerou este pedido (ver comentário de `toolRunningLabel`
 * em mapper.ts) — ausente em pedidos persistidos antes da correção de 28/09/2026. */
export type PermReq = { id: string; toolName: string; input: Record<string, unknown>; hasSuggestions: boolean; decision?: string; answer?: string; toolUseId?: string };
/**
 * Turno terminado por stop manual (botão Parar) — separado de `error` de propósito (ver
 * server/claude/runner.ts: evento/tipo persistido 'interrupted', nunca 'error', nesse caso). `text`/
 * `thinking` é o que já tinha sido gerado até o abort (o runner acumula a partir dos `stream_event` e
 * persiste no próprio evento — sem isso, esse texto some pra sempre ao recarregar, porque mensagens
 * parciais nunca são gravadas em claude_events). `duringTool`: havia pedido de permissão de
 * ferramenta pendente no momento do stop — mesmo espírito da distinção real da extensão entre
 * "Interrupted" e "Tool interrupted" (tabela `Qw` no webview decompilado v2.1.282), adaptado porque o
 * runner do Orion não tem o sentinela de texto que a extensão usa pra detectar isso.
 */
export type InterruptedState = { message: string; duringTool: boolean; text: string; thinking: string };
export type LiveState = {
  status: LiveStatus; messages: SdkMessage[]; partialText: string; partialThinking: string;
  pending: PermReq[]; resolvedPerms: PermReq[]; error: string | null; lastPrompt: string | null;
  /** Comandos de barra reais da sessão (server/claude/runner.ts, via Query.supportedCommands()); vazio até o servidor mandar (evento 'hello' ou 'commands'). */
  commands: SlashCommandInfo[];
  /** Último stop manual desta sessão, se o turno mais recente terminou assim — null no caso normal (turno completo, ou erro genuíno, que continua em `error`). Limpo quando o usuário manda uma nova mensagem (ver pushMessage). */
  interrupted: InterruptedState | null;
};
export type Row = { seq: number; ts?: string; type: string; payload: any };

export const emptyLive = (): LiveState => ({ status: 'idle', messages: [], partialText: '', partialThinking: '', pending: [], resolvedPerms: [], error: null, lastPrompt: null, commands: [], interrupted: null });

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
      // Nova mensagem do usuário: a interrupção do turno anterior (se houve) não vale mais pro que
      // vem a seguir — mesma janela de vida do erro genuíno (limpo quando volta a rodar, ver 'status').
      return { ...s, messages: [...s.messages, m], lastPrompt: t, partialText: '', partialThinking: '', interrupted: null };
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
      case 'permission_request': reqs.set(p.id, { id: p.id, toolName: p.toolName, input: p.input ?? {}, hasSuggestions: false, toolUseId: typeof p.toolUseId === 'string' ? p.toolUseId : undefined }); break;
      case 'permission_resolved': { const q = reqs.get(p.id); if (q) { q.decision = p.decision; if (typeof p.message === 'string') q.answer = p.message; } break; }
      case 'error': s = { ...s, error: String(p.message ?? 'erro') }; break;
      // Stop manual persistido (ver server/claude/runner.ts) — texto parcial reconstruído aqui, do
      // próprio payload do evento (nunca das mensagens parciais de streaming, que não são persistidas).
      case 'interrupted': s = { ...s, interrupted: { message: String(p.message ?? 'Interrompido pelo usuário'), duringTool: !!p.duringTool, text: String(p.partialText ?? ''), thinking: String(p.partialThinking ?? '') } }; break;
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
      // commands: só troca quando o servidor manda algo (sessão já rodou pelo menos um turno nesse
      // processo); sem isso, mantém o que já tínhamos em vez de apagar com [] a cada reconexão SSE.
      return { ...s, status: ev.status ?? s.status, pending, commands: Array.isArray(ev.commands) && ev.commands.length ? ev.commands : s.commands };
    }
    case 'commands': return { ...s, commands: Array.isArray(ev.commands) ? ev.commands : s.commands };
    // Novo turno rodando: a interrupção do turno anterior (se houve) não vale mais — mesma janela de
    // vida do erro genuíno logo abaixo (redundante com o reset em pushMessage no caminho normal, mas
    // essa é a primeira coisa que o servidor emite ao começar um turno — defesa a mais).
    case 'status': return { ...s, status: ev.status, error: ev.status === 'running' ? null : s.error, interrupted: ev.status === 'running' ? null : s.interrupted };
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
      return { ...s, status: 'waiting', pending: [...s.pending, { id: ev.id, toolName: ev.toolName, input: ev.input ?? {}, hasSuggestions: !!ev.hasSuggestions, toolUseId: typeof ev.toolUseId === 'string' ? ev.toolUseId : undefined }] };
    case 'permission_resolved': {
      // Move da pendência pra resolvida (em vez de só sumir): sem isso, o bubble "Você respondeu"
      // só aparecia depois de recarregar a página (fromRows), nunca na hora, ao vivo.
      const q = s.pending.find(p => p.id === ev.id);
      const resolved = q ? [...s.resolvedPerms, { ...q, decision: ev.decision, ...(typeof ev.message === 'string' ? { answer: ev.message } : {}) }] : s.resolvedPerms;
      return { ...s, pending: s.pending.filter(p => p.id !== ev.id), resolvedPerms: resolved };
    }
    case 'error': return { ...s, error: String(ev.message ?? 'erro'), partialText: '', partialThinking: '' };
    // Stop manual (ver server/claude/runner.ts) — ao vivo, o parcial já acumulado em s.partialText/
    // s.partialThinking é a fonte mais atual (o servidor manda o mesmo texto no payload, útil só pra
    // quem reconstrói via fromRows sem ter visto os 'partial' ao vivo); nunca mexe em s.error (evento
    // ortogonal, não é o mesmo caminho de erro genuíno).
    case 'interrupted':
      return {
        ...s,
        interrupted: {
          message: String(ev.message ?? 'Interrompido pelo usuário'),
          duringTool: !!ev.duringTool,
          text: s.partialText || (typeof ev.partialText === 'string' ? ev.partialText : ''),
          thinking: s.partialThinking || (typeof ev.partialThinking === 'string' ? ev.partialThinking : ''),
        },
        partialText: '',
        partialThinking: '',
      };
    case 'turn_end': return { ...s, partialText: '', partialThinking: '' };
    default: return s;
  }
}

/** O que a linha do tempo renderiza: mensagens reduzidas + parciais + pendências + erro. */
export function toConvEvents(s: LiveState): ConvEvent[] {
  // Corrige o status do bloco de ferramenta que já apareceu como "running"/"executando…" (assim que o
  // SDK manda o tool_use) mas cujo pedido de permissão ainda está pendente — ligado pelo toolUseId
  // real do SDK, nunca um heurístico (ver applyPendingToolWaitStatus/toolRunningLabel em mapper.ts,
  // achado numa investigação de "o padrão de mensagens tá diferente do plugin", PARIDADE.md).
  const pendingToolIds = s.pending.map(p => p.toolUseId).filter((x): x is string => !!x);
  const out = applyPendingToolWaitStatus(reduceSdkMessages(s.messages), pendingToolIds);
  if (s.partialThinking) out.push({ id: 'partial-thinking', kind: 'thinking', text: s.partialThinking, streaming: true });
  if (s.partialText) out.push({ id: 'partial-text', kind: 'text', text: s.partialText, streaming: true });
  // Stop manual: o que sobrou da resposta cortada, tagueado como interrompido (nunca some — ver bug
  // corrigido 28/09/2026, PARIDADE.md). Ao contrário do parcial "ao vivo" acima (streaming: true,
  // sem rótulo), este é um texto definitivo (o turno já terminou) com o selo amigável em
  // `interrupted` — mostrado mesmo sem texto (interrupção antes de gerar qualquer coisa), pra sempre
  // deixar rastro visível de que o turno foi cortado, tanto ao vivo quanto depois de recarregar.
  if (s.interrupted) {
    if (s.interrupted.thinking) out.push({ id: 'interrupted-thinking', kind: 'thinking', text: s.interrupted.thinking });
    out.push({ id: 'interrupted-text', kind: 'text', text: s.interrupted.text, interrupted: interruptedLabel(s.interrupted.duringTool) });
  }
  const parseQuestions = (input: Record<string, unknown>) => Array.isArray((input as any)?.questions) ? (input as any).questions : undefined;
  for (const p of [...s.resolvedPerms, ...s.pending]) {
    const d = describeTool(p.toolName, p.input);
    const isAsk = p.toolName === 'AskUserQuestion';
    out.push({ id: p.id, kind: 'permission', toolUseId: p.id, name: p.toolName, label: d.label, description: d.description ?? '', inputText: d.inputText ?? JSON.stringify(p.input, null, 2), questions: isAsk ? parseQuestions(p.input) : undefined, decision: p.decision as any, answer: p.answer });
  }
  if (s.error && s.status === 'error') out.push({ id: 'live-error', kind: 'result', ok: false, error: s.error });
  // Indicador "pensando" ao vivo (ícone + palavra pulsando/trocando — ver mapper.ts SPINNER_* e
  // Timeline.tsx ThinkingIndicator). Mesma condição da extensão real (`visiblyBusy &&
  // !permissionRequests.value.length`, achado lendo o webview decompilado — ver PARIDADE.md): aqui
  // isso já É status==='running' (o Orion só entra em 'waiting' quando há permissão pendente, e só
  // sai de 'waiting' de volta pra 'running' quando não sobra nenhuma — ver runner.ts), então não
  // precisou de estado novo no runner. Sempre por último, igual à extensão real (a linha do spinner
  // fica abaixo de tudo que já foi renderizado neste turno, não some no 1º token/tool_use — ela
  // acompanha o turno inteiro, só some ao entrar em 'waiting' ou terminar). Guard extra `!s.interrupted`:
  // evita mostrar o spinner por um instante junto com o bubble de interrupção, na janela entre o
  // evento 'interrupted' chegar (que não mexe em status) e o 'status':'idle' que vem logo depois.
  if (s.status === 'running' && !s.interrupted) out.push({ id: 'live-busy', kind: 'busy' });
  return out;
}
