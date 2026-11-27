/**
 * SDK falso (plano B1, T4): um QueryFn que ecoa o prompt sem subir o claude nem gastar token. Liga com
 * ORION_SDK_FALSO=1 (hospedarMotor.ts) pra testar o painel de ponta a ponta: Parar no meio do turno,
 * restart do painel/runner, pedido de permissão. Mesmo contrato do CLI em modo streaming: lê a entrada
 * viva em loop e responde cada mensagem com assistant + result, então serve também pro processo quente
 * do Runner (a próxima mensagem chega pela mesma entrada). Atraso por mensagem em ORION_SDK_FALSO_MS
 * (padrão 1500 ms). Texto com "permissao" pede permissão de Bash via canUseTool antes de responder.
 */
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from './runner.js';

export type OpcoesSdkFalso = {
  /** Espera antes de responder cada mensagem (0 nos testes). */
  atrasoMs?: number;
  /** Campo `result` do SDK; sem ele, o mesmo texto do eco. '' simula turno sem texto (cutucão). */
  result?: string;
  /** Ganchos de observação dos testes (tests/helpers/sdkFalso.ts). */
  aoLer?: (texto: string) => void;
  aoFechar?: () => void;
};

export const ATRASO_PADRAO_MS = 1500;

function textoDe(m: SDKUserMessage): string {
  const c = m.message.content;
  return typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join('');
}

/** setTimeout que o abort do turno (Parar) cancela com o mesmo erro que o CLI de verdade devolveria. */
function esperar(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Error('aborted'));
    const aoAbortar = () => { clearTimeout(t); rej(new Error('aborted')); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', aoAbortar); res(); }, ms);
    signal?.addEventListener('abort', aoAbortar, { once: true });
  });
}

export function criarSdkFalso(o: OpcoesSdkFalso = {}): QueryFn {
  return ({ prompt, options }) => {
    const signal = options?.abortController?.signal;
    const mensagens: AsyncIterable<SDKUserMessage> | SDKUserMessage[] = typeof prompt === 'string'
      ? [{ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage]
      : prompt;
    async function* gen(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', model: 'sdk-falso', cwd: options?.cwd, session_id: options?.sessionId ?? options?.resume } as unknown as SDKMessage;
      for await (const m of mensagens) {
        const texto = textoDe(m);
        o.aoLer?.(texto);
        const t0 = Date.now();
        await esperar(o.atrasoMs ?? ATRASO_PADRAO_MS, signal);
        if (/permissao/i.test(texto) && options?.canUseTool) {
          const r = await options.canUseTool('Bash', { command: 'echo permissao' }, { signal: signal ?? new AbortController().signal, toolUseID: `toolu_falso_${t0}` } as Parameters<NonNullable<Options['canUseTool']>>[2]);
          if (signal?.aborted) throw new Error('aborted');
          const texto = r?.behavior === 'allow' ? 'permissão concedida' : `permissão negada: ${(r as { message?: string } | null)?.message ?? ''}`;
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }] } } as unknown as SDKMessage;
        }
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${texto}` }] } } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: Date.now() - t0, result: o.result ?? `eco: ${texto}`, usage: { input_tokens: 1, output_tokens: 1 }, queued_turn_count: 0 } as unknown as SDKMessage;
      }
      o.aoFechar?.();
    }
    return gen();
  };
}

const atrasoEnv = () => { const v = Number(process.env.ORION_SDK_FALSO_MS); return process.env.ORION_SDK_FALSO_MS !== undefined && Number.isFinite(v) ? v : ATRASO_PADRAO_MS; };

/** O QueryFn que hospedarMotor usa com ORION_SDK_FALSO=1 (atraso lido do env a cada query, pra ajustar sem reiniciar). */
export const sdkFalso: QueryFn = (p) => criarSdkFalso({ atrasoMs: atrasoEnv() })(p);
