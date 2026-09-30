import { describe, it, expect } from 'vitest';
import { resultTokens, Runner, type Store, type LiveEvent, type QueryFn } from '../server/claude/runner';
import { buildSystemAppend, prefixPrompt, titleFromPrompt, FRASE_TOOL, REGRA_LINHAS_MAX, type MemoriaDecisao, type MemoriaRegra } from '../server/claude/header';

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
 * `liveControls`, quando passado, expõe `setPermissionMode`/`setModel`/`applyFlagSettings` no objeto
 * Query devolvido (mesmo padrão defensivo de `commands` acima) — cada chamada é registrada em
 * `liveCalls` (devolvido junto de `fn`/`calls`) pra os testes de `setPermissionModeLive`/
 * `setModelLive`/`setEffortLive` conferirem o que foi chamado, com quais argumentos.
 */
function fakeQuery(opts: { askPermission?: boolean; fail?: boolean; slow?: number; commands?: any[]; commandsChanged?: any[]; liveControls?: boolean } = {}): { fn: QueryFn; calls: any[]; liveCalls: any[] } {
  const calls: any[] = [];
  const liveCalls: any[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    async function* gen() {
      yield { type: 'system', subtype: 'init', model: 'claude-test', cwd: options?.cwd, session_id: options?.sessionId ?? options?.resume } as any;
      if (opts.commandsChanged) yield { type: 'system', subtype: 'commands_changed', commands: opts.commandsChanged } as any;
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } } } as any;
      if (opts.slow) await wait(opts.slow);
      if (options?.signal?.aborted || options?.abortController?.signal.aborted) throw new Error('aborted');
      if (opts.askPermission && options?.canUseTool) {
        // toolUseID: campo real do SDK (options do canUseTool, sdk.d.ts) — fixture fixo pra poder
        // afirmar, no teste novo abaixo, que o runner repassa esse id (não descarta mais, ver
        // PARIDADE.md "padrão de mensagens diferente do plugin").
        const r = await options.canUseTool('Bash', { command: 'ls' }, { signal: options.abortController!.signal, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' } as any], toolUseID: 'toolu_fixture_bash' } as any);
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: r.behavior === 'allow' ? 'permitido' : `negado: ${(r as any).message}` }] } } as any;
      }
      if (opts.fail) throw new Error('falhou de propósito');
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${prompt}` }] } } as any;
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, usage: { input_tokens: 120, output_tokens: 30 } } as any;
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

const base = { cwd: '/tmp/x', permissionMode: 'acceptEdits' as const, systemAppend: 'h' };

describe('Runner', () => {
  it('roda um turno, persiste eventos e termina em idle com tokens', async () => {
    const m = memStore(); const q = fakeQuery();
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s1', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's1', prompt: '[Danilo] olá', isNew: true });
    await until(() => m.sessions.get('s1')?.status === 'idle');
    expect(m.sessions.get('s1').tokens).toEqual({ input: 120, output: 30 });
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

  /**
   * Investigação de 28/09/2026 ("Bayerl: o padrão de mensagens tá diferente do plugin", ver
   * PARIDADE.md): `opts.toolUseID` é um campo real do `canUseTool` do SDK (`sdk.d.ts`: "Unique
   * identifier for this specific tool call within the assistant message") que o runner descartava —
   * sem ele, o mapper não tinha como ligar o bloco de ferramenta (que já aparece "executando…" assim
   * que o SDK manda o tool_use) ao pedido de permissão pendente que é dele de verdade, e o bloco
   * mostrava "executando…" antes mesmo do usuário decidir. Este teste confirma que o id agora é
   * repassado tanto no evento ao vivo (SSE) quanto no persistido (claude_events) — os dois caminhos
   * que `web/src/claude/live.ts` (fromRows/applyLive) lê.
   */
  it('repassa o toolUseId real do SDK (opts.toolUseID) no pedido de permissão, ao vivo e persistido', async () => {
    const m = memStore(); const q = fakeQuery({ askPermission: true });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('s3c', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 's3c', prompt: 'x', isNew: true });
    await until(() => r.status('s3c') === 'waiting');
    const liveReq = seen.find(e => e.type === 'permission_request') as any;
    expect(liveReq.toolUseId).toBe('toolu_fixture_bash');
    const persisted = m.events.find(e => e.type === 'permission_request')!;
    expect(persisted.payload.toolUseId).toBe('toolu_fixture_bash');
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

  it('confirmação de MCP (onElicitation) vira cartão; o texto digitado preenche o campo pedido', async () => {
    let elicit: any;
    const fn: QueryFn = ({ options }) => (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test', session_id: options?.sessionId } as any;
      elicit = await options!.onElicitation!({ serverName: 'github', message: 'Confirme', requestedSchema: { type: 'object', properties: { repository_name: { type: 'string' }, ok: { type: 'boolean' } } } }, { signal: options!.abortController!.signal, requestId: 'r1' });
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 } } as any;
    })() as any;
    const m = memStore(); const r = new Runner({ queryFn: fn, store: m.store });
    const seen: LiveEvent[] = []; r.subscribe('se', e => seen.push(e));
    r.startTurn({ ...base, sessionId: 'se', prompt: 'x', isNew: true });
    await until(() => r.status('se') === 'waiting');
    const req = seen.find(e => e.type === 'permission_request') as any;
    expect(req.toolName).toBe('Elicitation');
    expect(req.input).toMatchObject({ servidor: 'github', campo: 'repository_name' });
    await r.decide('se', req.id, 'answer', 1, 'bayerlcloud/x');
    await until(() => r.status('se') === 'idle');
    expect(elicit).toEqual({ action: 'accept', content: { repository_name: 'bayerlcloud/x', ok: true } });
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

  it('stop persiste um evento "interrupted" (nunca "error") com o texto parcial já gerado — bug corrigido 28/09/2026: antes esse texto se perdia pra sempre, porque mensagens parciais nunca são gravadas em claude_events e o catch de run() só gravava um "error" genérico sem o texto', async () => {
    // fakeQuery sem askPermission emite o stream_event de texto parcial ('oi') antes do wait(slow) e
    // do checkpoint de aborted — então, no momento do stop(), esse texto já está acumulado no runner.
    const m = memStore(); const q = fakeQuery({ slow: 100 });
    const r = new Runner({ queryFn: q.fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's8b', prompt: 'x', isNew: true });
    await until(() => r.status('s8b') === 'running');
    await r.stop('s8b');
    await until(() => m.sessions.get('s8b')?.status === 'idle', 3000);
    const ev = m.events.find(e => e.sessionId === 's8b' && e.type === 'interrupted');
    expect(ev).toBeTruthy();
    expect(ev!.payload).toMatchObject({ message: 'Interrompido pelo usuário', duringTool: false, partialText: 'oi', partialThinking: '' });
    // Nunca um 'error' genérico pra esse caminho — os dois tipos não se conflitam (ver runner.ts).
    expect(m.events.some(e => e.sessionId === 's8b' && e.type === 'error')).toBe(false);
  });

  it('stop durante um pedido de permissão pendente marca a interrupção como "durante uso de ferramenta" (duringTool)', async () => {
    // Fake bespoke (não o fakeQuery compartilhado): pede permissão e só verifica o abort DEPOIS do
    // canUseTool resolver — reproduz o real: stop() nega a pendência com interrupt:true E chama
    // abort() antes de devolver; a Query real jogaria uma exceção nesse ponto por causa do
    // AbortController já abortado (o fakeQuery genérico não modela esse timing, por isso um fake à parte).
    const m = memStore();
    const fn: QueryFn = ({ options }) => {
      async function* gen() {
        yield { type: 'system', subtype: 'init', model: 'm' } as any;
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'vou rodar um comando' } } } as any;
        await options!.canUseTool!('Bash', { command: 'ls' }, { signal: options!.abortController!.signal, suggestions: [] } as any);
        if (options!.abortController!.signal.aborted) throw new Error('aborted');
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'não deveria chegar aqui' }] } } as any;
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1 } as any;
      }
      return gen() as any;
    };
    const r = new Runner({ queryFn: fn, store: m.store });
    r.startTurn({ ...base, sessionId: 's8c', prompt: 'x', isNew: true });
    await until(() => r.status('s8c') === 'waiting');
    await r.stop('s8c');
    await until(() => m.sessions.get('s8c')?.status === 'idle', 3000);
    const ev = m.events.find(e => e.sessionId === 's8c' && e.type === 'interrupted');
    expect(ev).toBeTruthy();
    expect(ev!.payload).toMatchObject({ message: 'Interrompido pelo usuário', duringTool: true, partialText: 'vou rodar um comando' });
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

  // setPermissionModeLive/setModelLive/setEffortLive — bug real reportado pelo Bayerl ao vivo em
  // 28/09/2026 (sessão c4380a41-d263-408e-9543-4be08d1aea01, confirmado no Postgres de produção,
  // read-only: status 'waiting' com um permission_request pendente, permission_mode ainda
  // 'acceptEdits' — a troca pra "Auto" na UI nunca chegava ao servidor, porque só atualizava
  // useState local até a PRÓXIMA mensagem). As 3 chamadas ao vivo espelham os control methods reais
  // do SDK (setPermissionMode/setModel/applyFlagSettings, sdk.d.ts) com o mesmo padrão defensivo já
  // usado acima pra supportedCommands(): sem Query viva, ou com uma Query que não tem o método
  // (fake "burro"), devolvem false sem lançar — só quando o método existe de verdade é que aplicam e
  // devolvem true.
  describe('setPermissionModeLive / setModelLive / setEffortLive (troca ao vivo, mid-turno)', () => {
    it('sem Query viva (sessão desconhecida, nunca rodou neste processo): as 3 chamadas devolvem false, sem lançar', async () => {
      const m = memStore(); const r = new Runner({ queryFn: fakeQuery().fn, store: m.store });
      expect(await r.setPermissionModeLive('nunca-existiu', 'plan')).toBe(false);
      expect(await r.setModelLive('nunca-existiu', 'sonnet')).toBe(false);
      expect(await r.setEffortLive('nunca-existiu', 'high')).toBe(false);
    });

    it('Query viva mas sem nenhum control method (fake "burro", como os outros testes deste arquivo): as 3 chamadas devolvem false, sem lançar', async () => {
      const m = memStore(); const q = fakeQuery({ slow: 150 }); // sem liveControls
      const r = new Runner({ queryFn: q.fn, store: m.store });
      r.startTurn({ ...base, sessionId: 'lc1', prompt: 'x', isNew: true });
      // Espera a Query de verdade existir (não só status 'running', que fica visível um instante
      // antes — l.query só é atribuída depois que queryFn() de fato retorna, dentro de run()).
      await until(() => q.calls.length > 0);
      expect(await r.setPermissionModeLive('lc1', 'plan')).toBe(false);
      expect(await r.setModelLive('lc1', 'sonnet')).toBe(false);
      expect(await r.setEffortLive('lc1', 'high')).toBe(false);
      await r.stop('lc1');
    });

    it('setPermissionModeLive: Query viva com setPermissionMode — chama com o modo novo e devolve true', async () => {
      const m = memStore(); const q = fakeQuery({ slow: 150, liveControls: true });
      const r = new Runner({ queryFn: q.fn, store: m.store });
      r.startTurn({ ...base, sessionId: 'lc2', prompt: 'x', isNew: true });
      await until(() => q.calls.length > 0);
      expect(await r.setPermissionModeLive('lc2', 'auto')).toBe(true);
      expect(q.liveCalls).toContainEqual({ type: 'setPermissionMode', mode: 'auto' });
      await r.stop('lc2');
    });

    it('setModelLive: Query viva com setModel — chama com o modelo novo (ou undefined pra "sem override") e devolve true', async () => {
      const m = memStore(); const q = fakeQuery({ slow: 150, liveControls: true });
      const r = new Runner({ queryFn: q.fn, store: m.store });
      r.startTurn({ ...base, sessionId: 'lc3', prompt: 'x', isNew: true });
      await until(() => q.calls.length > 0);
      expect(await r.setModelLive('lc3', 'sonnet')).toBe(true);
      expect(await r.setModelLive('lc3', undefined)).toBe(true);
      expect(q.liveCalls).toContainEqual({ type: 'setModel', model: 'sonnet' });
      expect(q.liveCalls).toContainEqual({ type: 'setModel', model: undefined });
      await r.stop('lc3');
    });

    it('setEffortLive: Query viva com applyFlagSettings — chama com { effortLevel } e devolve true (SDK não tem setEffort() dedicado)', async () => {
      const m = memStore(); const q = fakeQuery({ slow: 150, liveControls: true });
      const r = new Runner({ queryFn: q.fn, store: m.store });
      r.startTurn({ ...base, sessionId: 'lc4', prompt: 'x', isNew: true });
      await until(() => q.calls.length > 0);
      expect(await r.setEffortLive('lc4', 'xhigh')).toBe(true);
      expect(q.liveCalls).toContainEqual({ type: 'applyFlagSettings', settings: { effortLevel: 'xhigh' } });
      await r.stop('lc4');
    });

    it('depois que o turno termina, a Query não fica mais acessível — as 3 chamadas voltam a devolver false', async () => {
      const m = memStore(); const q = fakeQuery({ liveControls: true });
      const r = new Runner({ queryFn: q.fn, store: m.store });
      r.startTurn({ ...base, sessionId: 'lc5', prompt: 'x', isNew: true });
      await until(() => m.sessions.get('lc5')?.status === 'idle');
      expect(await r.setPermissionModeLive('lc5', 'plan')).toBe(false);
      expect(await r.setModelLive('lc5', 'opus')).toBe(false);
      expect(await r.setEffortLive('lc5', 'low')).toBe(false);
    });
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

describe('header com memórias por nível (injeção das decisões de 28/09/2026)', () => {
  const base = { projectName: 'Orion', projectPath: '/srv/orion', createdBy: 'Danilo' };

  it('nível 2 entra com título e corpo; nível 3 só a linha de índice; frase da tool no fim', () => {
    const s = buildSystemAppend({ ...base,
      regras: [{ title: 'Testes antes do deploy', body: 'npm test\nnpm run typecheck', scope: 'projeto' }],
      decisoes: [{ code: 'orion-central-unico-painel', title: 'Painel único', summary: 'as VPS empurram, o painel nunca puxa' }],
    });
    expect(s).toContain('Regras e preferências (nível 2)');
    expect(s).toContain('- [projeto] Testes antes do deploy:');
    expect(s).toContain('  npm test');
    expect(s).toContain('  npm run typecheck');
    expect(s).toContain('Decisões fechadas (nível 3), só o índice:');
    expect(s).toContain('- [orion-central-unico-painel] Painel único: as VPS empurram, o painel nunca puxa');
    // o corpo da decisão nunca entra; só a linha de índice
    expect(s).toContain(FRASE_TOOL);
  });

  it('corpo do nível 2 é cortado na linha 15, com aviso honesto', () => {
    const corpo = Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join('\n');
    const s = buildSystemAppend({ ...base, regras: [{ title: 'Longa', body: corpo, scope: 'universal' }] });
    expect(s).toContain(`linha ${REGRA_LINHAS_MAX}`);
    expect(s).not.toContain(`linha ${REGRA_LINHAS_MAX + 1}\n`);
    expect(s).toContain(`corpo cortado na linha ${REGRA_LINHAS_MAX}`);
  });

  it('tetos: no máximo 10 regras e 20 decisões', () => {
    const regras: MemoriaRegra[] = Array.from({ length: 12 }, (_, i) => ({ title: `Regra ${i + 1}`, body: 'b', scope: 'universal' }));
    const decisoes: MemoriaDecisao[] = Array.from({ length: 25 }, (_, i) => ({ code: `dec-${i + 1}`, title: `Decisão ${i + 1}`, summary: 's' }));
    const s = buildSystemAppend({ ...base, regras, decisoes });
    expect(s).toContain('Regra 10');
    expect(s).not.toContain('Regra 11');
    expect(s).toContain('[dec-20]');
    expect(s).not.toContain('[dec-21]');
  });

  it('sem memórias de nível 2/3 não adiciona seção nenhuma nem a frase da tool', () => {
    const s = buildSystemAppend({ ...base, regras: [], decisoes: [] });
    expect(s).not.toContain('nível 2');
    expect(s).not.toContain('Decisões fechadas');
    expect(s).not.toContain(FRASE_TOOL);
  });

  it('níveis 0, 1 e 4 nunca têm seção no append (chegam pelo CLAUDE.md ou pela tool)', () => {
    const s = buildSystemAppend({ ...base,
      regras: [{ title: 'R', body: 'b', scope: 'universal' }],
      decisoes: [{ code: 'd', title: 'D', summary: 's' }],
    });
    expect(s).not.toContain('nível 0');
    expect(s).not.toContain('nível 1');
    expect(s).not.toContain('Micro-fatos');
  });
});

describe('resultTokens', () => {
  it('soma o modelUsage de todos os modelos; sem ele, usa o usage agregado', () => {
    expect(resultTokens({ modelUsage: { a: { inputTokens: 10, outputTokens: 2 }, b: { inputTokens: 5 } }, usage: { input_tokens: 999 } })).toEqual({ input: 15, output: 2 });
    expect(resultTokens({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ input: 7, output: 3 });
    expect(resultTokens({})).toEqual({ input: 0, output: 0 });
  });
});
