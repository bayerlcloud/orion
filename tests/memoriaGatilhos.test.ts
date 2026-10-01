import { describe, it, expect } from 'vitest';
import {
  LEMBRETE_COMPACT, RAZAO_STOP, makeStopMemoriaHook, novoEstadoTurno, pediuMemoria, registrarToolUse, sessionStartMemoriaHook,
} from '../server/claude/memoriaGatilhos.js';

const opts = { signal: new AbortController().signal };

describe('pediuMemoria', () => {
  it('reconhece pedido explícito e decisão fechada, ignorando o prefixo [Nome]', () => {
    expect(pediuMemoria(['[Danilo] lembra disso: deploy só pela fila'])).toBe(true);
    expect(pediuMemoria(['[Guilherme] então fica decidido, usamos o conector'])).toBe(true);
    expect(pediuMemoria(['[Laís] anota aí que o cliente prefere azul'])).toBe(true);
    expect(pediuMemoria(['[Danilo] a partir de agora resposta curta'])).toBe(true);
  });
  it('não dispara em conversa comum nem em aviso do próprio Orion', () => {
    expect(pediuMemoria(['[Danilo] como funciona a memória do Orion?'])).toBe(false);
    expect(pediuMemoria(['[Danilo] roda os testes e me fala'])).toBe(false);
    expect(pediuMemoria(['[Orion] lembra de resumir o que foi feito'])).toBe(false);
  });
});

describe('hook Stop', () => {
  it('bloqueia uma vez quando pediram memória e nada foi gravado; depois libera', async () => {
    const estado = novoEstadoTurno('[Danilo] grava: o preview usa o banco de produção');
    const hook = makeStopMemoriaHook(estado);
    expect(await hook({ hook_event_name: 'Stop', stop_hook_active: false } as any, undefined, opts)).toEqual({ decision: 'block', reason: RAZAO_STOP });
    expect(await hook({ hook_event_name: 'Stop', stop_hook_active: false } as any, undefined, opts)).toEqual({});
  });
  it('não bloqueia se a tool de memória foi usada, se não pediram, ou se o SDK já está num stop hook', async () => {
    const gravou = novoEstadoTurno('[Danilo] anota isso');
    registrarToolUse(gravou, [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'mcp__orion-memory__salvar', input: {} }]);
    expect(gravou.gravou).toBe(true);
    expect(await makeStopMemoriaHook(gravou)({ hook_event_name: 'Stop', stop_hook_active: false } as any, undefined, opts)).toEqual({});

    const semPedido = novoEstadoTurno('[Danilo] lista os arquivos');
    expect(await makeStopMemoriaHook(semPedido)({ hook_event_name: 'Stop', stop_hook_active: false } as any, undefined, opts)).toEqual({});

    const ativo = novoEstadoTurno('[Danilo] lembra disso');
    expect(await makeStopMemoriaHook(ativo)({ hook_event_name: 'Stop', stop_hook_active: true } as any, undefined, opts)).toEqual({});
  });
  it('mensagem que entrou no meio do turno também conta', async () => {
    const estado = novoEstadoTurno('[Danilo] roda os testes');
    estado.textos.push('[Danilo] ah, e lembra que o build é pela fila');
    expect(await makeStopMemoriaHook(estado)({ hook_event_name: 'Stop', stop_hook_active: false } as any, undefined, opts)).toMatchObject({ decision: 'block' });
  });
  it('outra tool (Bash, Read) não conta como gravação', () => {
    const estado = novoEstadoTurno('[Danilo] anota');
    registrarToolUse(estado, [{ type: 'tool_use', name: 'Bash', input: {} }]);
    registrarToolUse(estado, 'texto solto');
    expect(estado.gravou).toBe(false);
  });
});

describe('hook SessionStart', () => {
  it('só no compact injeta o lembrete', async () => {
    expect(await sessionStartMemoriaHook({ hook_event_name: 'SessionStart', source: 'compact' } as any, undefined, opts))
      .toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LEMBRETE_COMPACT } });
    expect(await sessionStartMemoriaHook({ hook_event_name: 'SessionStart', source: 'startup' } as any, undefined, opts)).toEqual({});
    expect(await sessionStartMemoriaHook({ hook_event_name: 'SessionStart', source: 'resume' } as any, undefined, opts)).toEqual({});
  });
});
