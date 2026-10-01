/**
 * Gatilhos de gravação da memória (entrega 2 de docs/plans/2026-10-01-memoria-v3.md): gravar
 * não depende só de o modelo lembrar.
 *
 * - Stop: se neste turno alguém pediu explicitamente para lembrar/anotar/gravar ou fechou uma
 *   decisão, e nenhuma chamada a orion-memory salvar/atualizar aconteceu, o fim do turno é
 *   bloqueado UMA vez com a razão abaixo: o modelo grava (ou explica em uma linha por que não) e
 *   encerra. `stop_hook_active` do SDK e a flag `cutucou` garantem que é uma vez só por turno.
 *   Lista de palavras curta de propósito (revisão de 01/10): lista grande vira bloqueio chato em
 *   todo turno. Ampliar só se a medição mostrar decisão perdida.
 * - SessionStart com source 'compact': o contexto foi resumido; lembrete curto para gravar o que
 *   ainda não foi gravado (o SDK não deixa rodar um turno antes de compactar; isto é o paliativo).
 *
 * Puro e testável: o estado do turno é um objeto que o runner alimenta (textos das mensagens
 * humanas do turno e se a tool de memória foi chamada).
 */
import type { HookCallback, SessionStartHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';

export type EstadoTurno = { textos: string[]; gravou: boolean; cutucou: boolean };

export function novoEstadoTurno(texto: string): EstadoTurno {
  return { textos: [texto], gravou: false, cutucou: false };
}

/** Pedido explícito de memória ou fechamento de decisão, na voz da pessoa. */
export const PEDIDO_EXPLICITO =
  /\b(lembra|lembre|lembrar|anota|anote|anotar|grava|grave|gravar|memoriza|memorize|memorizar|salva isso|guarda isso|decidido|fechado|fica combinado|a partir de agora|regra nova|nova regra)\b/i;

export const TOOLS_MEMORIA = new Set(['mcp__orion-memory__salvar', 'mcp__orion-memory__atualizar']);

/** Tira o prefixo [Nome] e os avisos do próprio Orion antes de procurar o pedido. */
export function pediuMemoria(textos: string[]): boolean {
  return textos.some((t) => {
    const semPrefixo = t.replace(/^\[([^\]]+)\]\s*/, (m, nome) => (nome === 'Orion' ? '\u0000' : ''));
    return !semPrefixo.startsWith('\u0000') && PEDIDO_EXPLICITO.test(semPrefixo);
  });
}

/** Marca que a tool de memória foi usada quando a mensagem do assistente traz um tool_use dela. */
export function registrarToolUse(estado: EstadoTurno, content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use' && TOOLS_MEMORIA.has(String((b as { name?: string }).name))) {
      estado.gravou = true;
    }
  }
}

export const RAZAO_STOP =
  'Antes de encerrar: neste turno a pessoa pediu para lembrar/anotar ou fechou uma decisão, e nada foi gravado na memória do Orion. '
  + 'Grave agora com orion-memory (salvar ou atualizar; nível 2 regra, 3 decisão fechada, 4 fato; escopo projeto, plataforma ou pessoa) e então encerre. '
  + 'Se não houver nada durável para guardar, encerre dizendo isso em uma linha.';

export function makeStopMemoriaHook(estado: EstadoTurno): HookCallback {
  return async (input) => {
    const i = input as StopHookInput;
    if (i.hook_event_name !== 'Stop' || i.stop_hook_active || estado.cutucou || estado.gravou || !pediuMemoria(estado.textos)) return {};
    estado.cutucou = true;
    return { decision: 'block', reason: RAZAO_STOP };
  };
}

export const LEMBRETE_COMPACT =
  'O contexto desta sessão acabou de ser compactado. Se houve decisão, regra ou fato durável ainda não gravado na memória do Orion, grave agora com orion-memory antes de seguir.';

export const sessionStartMemoriaHook: HookCallback = async (input) => {
  const i = input as SessionStartHookInput;
  if (i.hook_event_name !== 'SessionStart' || i.source !== 'compact') return {};
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LEMBRETE_COMPACT } };
};
