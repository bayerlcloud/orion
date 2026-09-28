import { describe, it, expect } from 'vitest';
import { Runner, type Store, type LiveEvent, type QueryFn } from '../server/claude/runner';
import { buildSystemAppend, prefixPrompt, titleFromPrompt } from '../server/claude/header';

function memStore() {
  const events: { sessionId: string; type: string; payload: any }[] = [];
  const sessions = new Map<string, any>();
  const approvals = new Map<string, any>();
  const store: Store = {
    async appendEvent(sessionId, type, payload) { events.push({ sessionId, type, payload }); },
    async updateSession(sessionId, patch) { sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), ...patch }); },
    async createApproval(a) { approvals.set(a.id, { ...a }); },
    async decideApproval(id, decision, decidedBy) { approvals.set(id, { ...(approvals.get(id) ?? {}), decision, decidedBy }); },
  };
  return { store, events, sessions, approvals };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(5); } }

/**
 * SDK falso: emite init, pede permissão para Bash, devolve texto e result. `commands`, quando
 * passado, expõe `supportedCommands()` no objeto Query devolvido (como o SDK real faz, mas os outros
 * testes deste arquivo — sem essa opção — reproduzem de propósito um fake "burro" sem métodos de
 * controle, pra garantir que o runner nunca quebra chamando um método que não existe).
 * `commandsChanged`, quando passado, emite um `system/commands_changed` (push do SDK) no meio do turno.
 */
function fakeQuery(opts: { askPermission?: boolean; fail?: boolean; slow?: number; commands?: any[]; commandsChanged?: any[] } = {}): { fn: QueryFn; calls: any[] } {
  const calls: any[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    async function* gen() {
      yield { type: 'system', subtype: 'init', model: 'claude-test', cwd: options?.cwd, session_id: options?.sessionId ?? options?.resume } as any;
      if (opts.commandsChanged) yield { type: 'system', subtype: 'commands_changed', commands: opts.commandsChanged } as any;
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } } } as any;
      if (opts.slow) await wait(opts.slow);
      if (options?.signal?.aborted || options?.abortController?.signal.aborted) throw new Error('aborted');
      if (opts.askPermission && options?.canUseTool) {
        const r = await options.canUseTool('Bash', { command: 'ls' }, { signal: options.abortController!.signal, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' } as any] });
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: r.behavior === 'allow' ? 'permitido' : `negado: ${(r as any).message}` }] } } as any;
      }
      if (opts.fail) throw new Error('falhou de propósito');
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${prompt}` }] } } as any;
      yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 1, duration_ms: 5 } as any;
    }
    const g = gen();
    if (opts.commands) (g as any).supportedCommands = async () => opts.commands;
    return g as any;
  };
  return { fn, calls };
}

const base = { cwd: '/tmp/x', permissionMode: 'acceptEdits' as const, systemAppend: 'h' };

describe('Runner', () => {
  it('roda um turno, persiste eventos e termina em idle com custo', async () => {
    const m = memStore(); const q = fakeQuery();
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s1', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's1', prompt: '[Danilo] olá', isNew: true });
    await until(() => m.sessions.get('s1')?.status === 'idle');
    expect(m.sessions.get('s1').costUsd).toBe(0.01);
    expect(m.events.map(e => e.type)).toEqual(['user_prompt', 'system', 'assistant', 'result']);
    expect(seen.some(e => e.type === 'partial')).toBe(true);
    expect(seen.filter(e => e.type === 'message').length).toBe(4);
    expect(q.calls[0].options.sessionId).toBe('s1');
    expect(q.calls[0].options.permissionMode).toBe('acceptEdits');
    expect(q.calls[0].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'h' });
  });

  it('nunca passa bypassPermissions nem allowDangerouslySkipPermissions', async () => {
    const m = memStore(); const q = fakeQuery();
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's2', prompt: 'x', isNew: true });
    await until(() => m.sessions.get('s2')?.status === 'idle');
    expect(q.calls[0].options.permissionMode).not.toBe('bypassPermissions');
    expect(q.calls[0].options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('pedido de permissão: fica waiting, allow_always devolve as sugestões, volta a running e termina', async () => {
    const m = memStore(); const q = fakeQuery({ askPermission: true });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s3', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's3', prompt: 'x', isNew: true });
    await until(() => r.status('s3') === 'waiting');
    const req = seen.find(e => e.type === 'permission_request') as any;
    expect(req.toolName).toBe('Bash'); expect(req.hasSuggestions).toBe(true);
    expect(r.pendingPermissions('s3')).toHaveLength(1);
    expect(await r.decide('s3', req.id, 'allow_always', 1)).toBe(true);
    await until(() => m.sessions.get('s3')?.status === 'idle');
    expect(m.approvals.get(req.id).decision).toBe('allow_always');
    const texts = m.events.filter(e => e.type === 'assistant').map(e => e.payload.message.content[0].text);
    expect(texts[0]).toBe('permitido');
    expect(await r.decide('s3', req.id, 'allow', 1)).toBe(false);
  });

  it('responder (AskUserQuestion) manda a mensagem no evento ao vivo, não só no evento persistido', async () => {
    // Bug real: o LiveEvent 'permission_resolved' emitido via SSE não carregava `message` (só o
    // evento gravado no banco carregava) — então, numa sessão aberta ao vivo, a tela nunca tinha a
    // resposta pra mostrar no bubble "Você respondeu" sem recarregar a página primeiro.
    const m = memStore(); const q = fakeQuery({ askPermission: true });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s3b', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's3b', prompt: 'x', isNew: true });
    await until(() => r.status('s3b') === 'waiting');
    const req = seen.find(e => e.type === 'permission_request') as any;
    await r.decide('s3b', req.id, 'answer', 1, 'Escopo de tarefas autônomas');
    const resolved = seen.find(e => e.type === 'permission_resolved') as any;
    expect(resolved.decision).toBe('answer');
    expect(resolved.message).toBe('Escopo de tarefas autônomas');
  });

  it('negar com mensagem repassa a mensagem ao Claude', async () => {
    const m = memStore(); const q = fakeQuery({ askPermission: true });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s4', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's4', prompt: 'x', isNew: true });
    await until(() => r.status('s4') === 'waiting');
    const req = seen.find(e => e.type === 'permission_request') as any;
    await r.decide('s4', req.id, 'deny', 1, 'usa outro caminho');
    await until(() => m.sessions.get('s4')?.status === 'idle');
    const texts = m.events.filter(e => e.type === 'assistant').map(e => e.payload.message.content[0].text);
    expect(texts[0]).toBe('negado: usa outro caminho');
  });

  it('permissão sem resposta expira em deny', async () => {
    const m = memStore(); const q = fakeQuery({ askPermission: true });
    const r = new Runner({ queryFn: q.fn, store: m.store, permissionTimeoutMs: 30 });
    r.startTurn({ ...base, sessionId: 's5', prompt: 'x', isNew: true });
    await until(() => m.sessions.get('s5')?.status === 'idle');
    const texts = m.events.filter(e => e.type === 'assistant').map(e => e.payload.message.content[0].text);
    expect(texts[0]).toMatch(/^negado: Sem resposta/);
    expect(m.events.some(e => e.type === 'permission_resolved' && e.payload.decision === 'timeout')).toBe(true);
  });

  it('segundo prompt durante turno entra na fila e roda com resume', async () => {
    const m = memStore(); const q = fakeQuery({ slow: 40 });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's6', prompt: 'um', isNew: true });
    await until(() => r.status('s6') === 'running');
    r.startTurn({ ...base, sessionId: 's6', prompt: 'dois', isNew: true });
    await until(() => q.calls.length === 2 && m.sessions.get('s6')?.status === 'idle' && m.events.filter(e => e.type === 'result').length === 2, 3000);
    expect(q.calls[1].prompt).toBe('dois');
    expect(q.calls[1].options.resume).toBe('s6');
    expect(q.calls[1].options.sessionId).toBeUndefined();
  });

  it('erro do SDK vira status error com mensagem, sem derrubar o runner', async () => {
    const m = memStore(); const q = fakeQuery({ fail: true });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's7', prompt: 'x', isNew: true });
    await until(() => m.sessions.get('s7')?.status === 'error');
    expect(m.sessions.get('s7').lastError).toContain('falhou de propósito');
    expect(m.events.some(e => e.type === 'error')).toBe(true);
  });

  it('stop aborta o turno e a sessão volta a idle', async () => {
    const m = memStore(); const q = fakeQuery({ slow: 200 });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's8', prompt: 'x', isNew: true });
    await until(() => r.status('s8') === 'running');
    await r.stop('s8');
    await until(() => m.sessions.get('s8')?.status === 'idle', 3000);
    expect(m.sessions.get('s8').lastError).toBe('Interrompido pelo usuário');
  });

  it('sem Query.supportedCommands() (fake burro, como todos os outros testes acima): commandsFor fica [] e nada quebra', async () => {
    const m = memStore(); const q = fakeQuery();
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's9', prompt: 'x', isNew: true });
    await until(() => m.sessions.get('s9')?.status === 'idle');
    expect(r.commandsFor('s9')).toEqual([]);
  });

  it('depois do init, chama Query.supportedCommands() e expõe o resultado via commandsFor + evento "commands"', async () => {
    const commands = [{ name: 'clear', description: 'Limpa o contexto', argumentHint: '', builtin: true }];
    const m = memStore(); const q = fakeQuery({ commands });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s10', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's10', prompt: 'x', isNew: true });
    await until(() => m.sessions.get('s10')?.status === 'idle');
    await until(() => r.commandsFor('s10').length > 0);
    expect(r.commandsFor('s10')).toEqual(commands);
    const ev = seen.find(e => e.type === 'commands') as any;
    expect(ev.commands).toEqual(commands);
  });

  it('push commands_changed no meio da sessão substitui a lista (REPLACE, não soma)', async () => {
    const initial = [{ name: 'clear', description: 'a', argumentHint: '' }];
    const changed = [{ name: 'clear', description: 'a', argumentHint: '' }, { name: 'deploy', description: 'skill descoberta', argumentHint: '' }];
    const m = memStore(); const q = fakeQuery({ commands: initial, commandsChanged: changed });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's11', prompt: 'x', isNew: true });
    await until(() => m.sessions.get('s11')?.status === 'idle');
    expect(r.commandsFor('s11')).toEqual(changed);
  });
});

describe('header', () => {
  it('monta o cabeçalho com projeto, pasta, pessoa, regras e memória', () => {
    const s = buildSystemAppend({ projectName: 'Orion', projectPath: '/srv/orion', createdBy: 'Danilo', rules: 'Sem console.log', userMemory: 'Prefere respostas curtas' });
    expect(s).toContain('projeto "Orion"'); expect(s).toContain('/srv/orion'); expect(s).toContain('"Danilo"');
    expect(s).toContain('Sem console.log'); expect(s).toContain('Prefere respostas curtas');
  });
  it('omite regras e memória vazias', () => {
    const s = buildSystemAppend({ projectName: 'X', projectPath: '/x', createdBy: 'A', rules: '  ', userMemory: null });
    expect(s).not.toContain('Regras do projeto'); expect(s).not.toContain('Memória sobre');
  });
  it('prefixa o prompt com o nome e gera título curto', () => {
    expect(prefixPrompt('Laís', 'oi')).toBe('[Laís] oi');
    expect(prefixPrompt('  ', 'oi')).toBe('[alguém] oi');
    expect(titleFromPrompt('  cria um subdomínio\nsegunda linha')).toBe('cria um subdomínio');
    expect(titleFromPrompt('a'.repeat(100)).length).toBe(60);
    expect(titleFromPrompt('')).toBe('Nova sessão');
  });
});

describe('header com memórias', () => {
  it('lista as memórias e marca a de importância máxima', () => {
    const s = buildSystemAppend({ projectName: 'Orion', projectPath: '/srv/orion', createdBy: 'Danilo', memories: [
      { title: 'Regra de ouro', summary: 'sempre testar', status: 'deus', scope: 'projeto' },
      { title: 'Prefere PT', summary: 'responde em português', status: 'aprendizagem', scope: 'usuário' },
    ] });
    expect(s).toContain('Memórias que valem para esta sessão');
    expect(s).toMatch(/Regra de ouro: sempre testar/);
    expect(s).toContain('importância máxima');
    expect(s).toMatch(/\[usuário\] Prefere PT/);
  });
  it('sem memórias não adiciona a seção', () => {
    expect(buildSystemAppend({ projectName: 'X', projectPath: '/x', createdBy: 'A', memories: [] })).not.toContain('Memórias que valem');
  });
});
