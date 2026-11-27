/**
 * SDKs falsos compartilhados pelos testes do Runner e do motor (extraídos de runner.test.ts e
 * runnerQuente.test.ts no plano B1, T2). Em T4 o fakeQuente é promovido a server/claude/sdkFalso.ts.
 */
import type { QueryFn } from '../../server/claude/runner';

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until(fn: () => boolean, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(5); } }

/**
 * SDK falso (processo por turno): emite init, pede permissão para Bash, devolve texto e result. `commands`, quando
 * passado, expõe `supportedCommands()` no objeto Query devolvido (como o SDK real faz, mas os outros
 * testes de runner.test.ts, sem essa opção, reproduzem de propósito um fake "burro" sem métodos de
 * controle, pra garantir que o runner nunca quebra chamando um método que não existe).
 * `commandsChanged`, quando passado, emite um `system/commands_changed` (push do SDK) no meio do turno.
 * `liveControls`, quando passado, expõe `setPermissionMode`/`setModel`/`applyFlagSettings` no objeto
 * Query devolvido (mesmo padrão defensivo de `commands` acima); cada chamada é registrada em
 * `liveCalls` (devolvido junto de `fn`/`calls`) pra os testes de `setPermissionModeLive`/
 * `setModelLive`/`setEffortLive` conferirem o que foi chamado, com quais argumentos.
 */
export function fakeQuery(opts: { askPermission?: boolean; fail?: boolean; slow?: number; commands?: any[]; commandsChanged?: any[]; liveControls?: boolean; result?: string } = {}): { fn: QueryFn; calls: any[]; liveCalls: any[] } {
  const calls: any[] = [];
  const liveCalls: any[] = [];
  const fn: QueryFn = ({ prompt: entrada, options }) => {
    const call: any = { prompt: undefined, options }; calls.push(call);
    async function* gen() {
      // O runner sempre manda a entrada viva (streaming); o fake lê só a primeira mensagem.
      let prompt: any = entrada;
      if (typeof entrada !== 'string') for await (const msg of entrada) { prompt = msg.message.content; break; }
      call.prompt = prompt;
      yield { type: 'system', subtype: 'init', model: 'claude-test', cwd: options?.cwd, session_id: options?.sessionId ?? options?.resume } as any;
      if (opts.commandsChanged) yield { type: 'system', subtype: 'commands_changed', commands: opts.commandsChanged } as any;
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } } } as any;
      if (opts.slow) await wait(opts.slow);
      if (options?.signal?.aborted || options?.abortController?.signal.aborted) throw new Error('aborted');
      if (opts.askPermission && options?.canUseTool) {
        // toolUseID: campo real do SDK (options do canUseTool, sdk.d.ts); fixture fixo pra poder
        // afirmar que o runner repassa esse id (não descarta mais, ver PARIDADE.md "padrão de
        // mensagens diferente do plugin").
        const r = await options.canUseTool('Bash', { command: 'ls' }, { signal: options.abortController!.signal, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' } as any], toolUseID: 'toolu_fixture_bash' } as any);
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: r.behavior === 'allow' ? 'permitido' : `negado: ${(r as any).message}` }] } } as any;
      }
      if (opts.fail) throw new Error('falhou de propósito');
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${prompt}` }] } } as any;
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, usage: { input_tokens: 120, output_tokens: 30 }, ...(opts.result !== undefined ? { result: opts.result } : {}) } as any;
    }
    const g = gen();
    if (opts.commands) (g as any).supportedCommands = async () => opts.commands;
    if (opts.liveControls) {
      (g as any).setPermissionMode = async (mode: string) => { liveCalls.push({ type: 'setPermissionMode', mode }); };
      (g as any).setModel = async (model?: string) => { liveCalls.push({ type: 'setModel', model }); };
      (g as any).applyFlagSettings = async (settings: any) => { liveCalls.push({ type: 'applyFlagSettings', settings }); };
    }
    return g as any;
  };
  return { fn, calls, liveCalls };
}

/** CLI falso quente: lê mensagens da entrada em loop e responde cada uma com assistant + result (como o CLI real em modo streaming). */
export function fakeQuente(opts: { result?: string; liveControls?: boolean } = {}) {
  const calls: { prompts: string[]; options: any; fechado: boolean }[] = [];
  const liveCalls: any[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const call = { prompts: [] as string[], options, fechado: false }; calls.push(call);
    async function* gen() {
      yield { type: 'system', subtype: 'init', model: 'x' } as any;
      for await (const msg of prompt as AsyncIterable<any>) {
        const text = typeof msg.message.content === 'string' ? msg.message.content : msg.message.content[0].text;
        call.prompts.push(text);
        if (options?.abortController?.signal.aborted) throw new Error('aborted');
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${text}` }] } } as any;
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: opts.result ?? 'feito', usage: { input_tokens: 1, output_tokens: 1 }, queued_turn_count: 0 } as any;
      }
      call.fechado = true;
    }
    const g = gen();
    if (opts.liveControls) {
      (g as any).setPermissionMode = async (mode: string) => { liveCalls.push({ type: 'setPermissionMode', mode }); };
      (g as any).setModel = async (model?: string) => { liveCalls.push({ type: 'setModel', model }); };
      (g as any).applyFlagSettings = async (settings: any) => { liveCalls.push({ type: 'applyFlagSettings', settings }); };
    }
    return g as any;
  };
  return { fn, calls, liveCalls };
}
