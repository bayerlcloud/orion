import { describe, it, expect } from 'vitest';
import { applyLive, emptyLive, fromRows, toConvEvents } from '../web/src/claude/live';

/** Pergunta real da sessão de produção "Esta ai?" (ver mapper.test.ts para a origem completa). */
const PROD_ASK_INPUT = {
  questions: [{
    header: 'Tipo de poder',
    question: "Quando você diz 'te dar mais poder', qual dessas frentes você quer destravar primeiro?",
    multiSelect: true,
    options: [
      { label: 'Permissões do Claude Code aqui no CLI', description: 'x' },
      { label: 'Escopo de tarefas autônomas', description: 'y' },
    ],
  }],
};

describe('fromRows', () => {
  it('reconstrói prompt, mensagens e pendência do servidor', () => {
    const s = fromRows([
      { seq: 1, type: 'user_prompt', payload: { prompt: '[Danilo] oi' } },
      { seq: 2, type: 'system', payload: { type: 'system', subtype: 'init', model: 'm' } },
      { seq: 3, type: 'assistant', payload: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } } },
      { seq: 4, type: 'permission_request', payload: { id: 'p1', toolName: 'Bash', input: { command: 'rm x' } } },
      { seq: 5, type: 'permission_request', payload: { id: 'p0', toolName: 'Bash', input: {} } },
      { seq: 6, type: 'permission_resolved', payload: { id: 'p0', decision: 'allow' } },
    ], 'waiting', [{ id: 'p1', toolName: 'Bash' }]);
    expect(s.messages.map(m => m.type)).toEqual(['user', 'system', 'assistant']);
    expect(s.pending.map(p => p.id)).toEqual(['p1']);
    const ev = toConvEvents(s);
    // p0 (resolvida) aparece antes de p1 (pendente) — permissões resolvidas não somem mais
    expect(ev.map(e => e.kind)).toEqual(['user', 'system', 'tool', 'permission', 'permission']);
    const pend = ev.find(e => e.kind === 'permission' && !e.decision);
    expect(pend && pend.kind === 'permission' && pend.inputText).toBe('rm x');
    const resolvida = ev.find(e => e.kind === 'permission' && e.decision === 'allow');
    expect(!!resolvida).toBe(true);
  });
  it('AskUserQuestion respondido: o bubble "Você respondeu" carrega o texto da resposta, nunca o JSON da pergunta', () => {
    // Reproduz o bug reportado: antes, permission_resolved não guardava a `message` do evento em
    // lugar nenhum, então o bubble caía no fallback `inputText` que, pra AskUserQuestion, virava
    // JSON.stringify(input) inteiro (perguntas + opções). Ver runner.ts (decide) e mapper.ts (describeTool).
    const rows = [
      { seq: 1, type: 'permission_request', payload: { id: 'ask1', toolName: 'AskUserQuestion', input: PROD_ASK_INPUT } },
      { seq: 2, type: 'permission_resolved', payload: { id: 'ask1', decision: 'answer', message: 'Escopo de tarefas autônomas' } },
    ];
    const s = fromRows(rows, 'idle', []);
    const ev = toConvEvents(s).find(e => e.kind === 'permission');
    expect(ev?.kind === 'permission' && ev.decision).toBe('answer');
    const shown = (ev as any).answer ?? (ev as any).inputText;
    expect(shown).toBe('Escopo de tarefas autônomas');
    expect(shown).not.toContain('{');
    expect(shown).not.toContain('multiSelect');
    expect(shown).not.toContain('options');
  });
  it('reproduz a sessão de produção "Esta ai?": 2 AskUserQuestion nunca resolvidos (decision null no banco) aparecem como expirados, não pendentes pra sempre', () => {
    // claude_approvals reais dessa sessão (fcc5ee4b-96f2-45a5-baf3-78e9f1f71ecd): dois AskUserQuestion
    // com decision/decided_at null pra sempre — o processo reiniciou minutos depois de cada pedido
    // (ver journalctl: restarts às 04:06:56 e 04:16:05, ~2-9 min depois de cada pedido de 04:04:30 e
    // 04:13:54), matando o Map em memória do Runner (e o timer de 30 min) antes de qualquer resolução.
    const rows = [
      { seq: 1, type: 'permission_request', payload: { id: '9dc0ed00', toolName: 'Bash', input: { command: 'ls -la /srv/orion' } } },
      { seq: 2, type: 'permission_request', payload: { id: '8cddcaaa', toolName: 'AskUserQuestion', input: PROD_ASK_INPUT } },
      { seq: 3, type: 'permission_request', payload: { id: 'bfe20541', toolName: 'AskUserQuestion', input: PROD_ASK_INPUT } },
    ];
    // Depois do restart, o processo novo não tem nada pendente pra essa sessão (Map vazio).
    const s = fromRows(rows, 'idle', []);
    const evs = toConvEvents(s).filter(e => e.kind === 'permission');
    expect(evs).toHaveLength(3);
    expect(evs.every(e => e.kind === 'permission' && e.decision === 'timeout')).toBe(true);
    // Nenhum fica preso em "pendente" (o que deixaria a UI sem jeito de responder pra sempre).
    expect(s.pending).toHaveLength(0);
  });
  it('erro persistido só aparece se o status atual é error', () => {
    const rows = [{ seq: 1, type: 'error', payload: { message: 'sem login' } }];
    expect(toConvEvents(fromRows(rows, 'error', [])).at(-1)).toMatchObject({ kind: 'result', ok: false, error: 'sem login' });
    expect(toConvEvents(fromRows(rows, 'idle', []))).toEqual([]);
  });

  /**
   * Regressão do bug corrigido em 28/09/2026 (achado por auditoria dedicada, ver PARIDADE.md): o
   * botão Parar aborta o turno; o runner acabava gravando um evento genérico 'error' e status 'idle'
   * (não 'error') — e tanto `fromRows` quanto `toConvEvents` só mostravam erro/interrupção quando
   * `status === 'error'` literalmente, então num stop manual (status idle) o texto nunca aparecia, e
   * como mensagens parciais de streaming nunca eram persistidas em claude_events, não sobrava nem
   * rastro pra reconstruir ao recarregar a página — o turno simplesmente sumia. A correção: o runner
   * agora persiste um tipo de evento PRÓPRIO ('interrupted', nunca 'error') com o texto parcial já
   * acumulado, e a reconstrução aqui não depende de `status` pra decidir se mostra — só de existir ou
   * não o evento (exatamente porque status 'idle' É o resultado correto de um stop, ao contrário de
   * um erro genuíno). Os testes abaixo usam a shape exata que `server/claude/runner.ts` persiste (ver
   * `tests/runner.test.ts` "stop persiste um evento 'interrupted'...").
   */
  it('stop manual (status idle após abort): o texto parcial da resposta cortada sobrevive ao reload, tagueado como interrompido — nunca escondido atrás do gate is-error', () => {
    const rows = [
      { seq: 1, type: 'user_prompt', payload: { prompt: 'liste os arquivos do projeto' } },
      { seq: 2, type: 'system', payload: { type: 'system', subtype: 'init', model: 'claude-test' } },
      { seq: 3, type: 'interrupted', payload: { message: 'Interrompido pelo usuário', duringTool: false, partialText: 'Vou listar os arquivos do projeto', partialThinking: '' } },
    ];
    const s = fromRows(rows, 'idle', []);
    expect(s.status).toBe('idle');
    expect(s.interrupted).toMatchObject({ message: 'Interrompido pelo usuário', duringTool: false, text: 'Vou listar os arquivos do projeto' });
    // Continua null: interrupção não é o mesmo caminho de erro genuíno (evita reabrir bugs antigos ali).
    expect(s.error).toBeNull();
    const ev = toConvEvents(s);
    const textEv = ev.find(e => e.kind === 'text');
    expect(textEv).toMatchObject({ kind: 'text', text: 'Vou listar os arquivos do projeto', interrupted: 'Interrompido' });
  });
  it('stop durante uso de ferramenta (duringTool: true): rótulo "Ferramenta interrompida", distinto do stop em geração de texto', () => {
    const rows = [{ seq: 1, type: 'interrupted', payload: { message: 'Interrompido pelo usuário', duringTool: true, partialText: 'vou rodar um comando', partialThinking: '' } }];
    const ev = toConvEvents(fromRows(rows, 'idle', []));
    expect(ev.find(e => e.kind === 'text')).toMatchObject({ interrupted: 'Ferramenta interrompida' });
  });
  it('interrupção sem nenhum texto parcial (cortado antes de gerar qualquer coisa) ainda mostra o selo — rastro visível de que o turno foi cortado', () => {
    const rows = [{ seq: 1, type: 'interrupted', payload: { message: 'Interrompido pelo usuário', duringTool: false, partialText: '', partialThinking: '' } }];
    const ev = toConvEvents(fromRows(rows, 'idle', []));
    expect(ev.find(e => e.kind === 'text')).toMatchObject({ text: '', interrupted: 'Interrompido' });
  });
  it('uma nova mensagem do usuário limpa a interrupção do turno anterior (não fica marcando pra sempre)', () => {
    const rows = [
      { seq: 1, type: 'interrupted', payload: { message: 'Interrompido pelo usuário', duringTool: false, partialText: 'meio caminho', partialThinking: '' } },
      { seq: 2, type: 'user_prompt', payload: { prompt: 'continua' } },
      { seq: 3, type: 'assistant', payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'terminei dessa vez' }] } } },
    ];
    const s = fromRows(rows, 'idle', []);
    expect(s.interrupted).toBeNull();
    const textEvs = toConvEvents(s).filter(e => e.kind === 'text');
    expect(textEvs).toHaveLength(1);
    expect(textEvs[0]).toMatchObject({ text: 'terminei dessa vez' });
    expect((textEvs[0] as any).interrupted).toBeUndefined();
  });
});

describe('applyLive', () => {
  it('acumula parciais de texto e pensamento e limpa quando a mensagem completa chega', () => {
    let s = emptyLive();
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pen' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'sando' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ol' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'á' } } });
    expect(s.partialThinking).toBe('pensando'); expect(s.partialText).toBe('olá');
    const ev = toConvEvents(s);
    expect(ev.map(e => e.kind)).toEqual(['thinking', 'text']);
    expect(ev[1].kind === 'text' && ev[1].streaming).toBe(true);
    s = applyLive(s, { type: 'message', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'olá' }] } } });
    expect(s.partialText).toBe(''); expect(s.partialThinking).toBe('');
    expect(toConvEvents(s).map(e => e.kind)).toEqual(['text']);
  });
  it('não duplica o eco do prompt', () => {
    let s = applyLive(emptyLive(), { type: 'message', message: { type: 'user', message: { content: '[D] oi' } } });
    s = applyLive(s, { type: 'message', message: { type: 'user', message: { content: '[D] oi' } } });
    expect(s.messages).toHaveLength(1);
  });
  it('permissão entra, muda status e sai quando resolvida', () => {
    let s = applyLive(emptyLive(), { type: 'permission_request', id: 'p', toolName: 'Bash', input: { command: 'x' }, hasSuggestions: true });
    expect(s.status).toBe('waiting'); expect(s.pending).toHaveLength(1);
    s = applyLive(s, { type: 'permission_request', id: 'p', toolName: 'Bash', input: {}, hasSuggestions: true });
    expect(s.pending).toHaveLength(1);
    s = applyLive(s, { type: 'permission_resolved', id: 'p', decision: 'allow' });
    expect(s.pending).toHaveLength(0);
  });
  it('permissão respondida ao vivo (sem reload): vira bubble resolvido na hora, com a resposta', () => {
    // Antes, permission_resolved só tirava o item de `pending` sem guardar em lugar nenhum — o
    // bubble "Você respondeu" só aparecia depois de recarregar a página (via fromRows). Ao vivo,
    // a resposta simplesmente sumia da tela sem confirmação nenhuma.
    let s = applyLive(emptyLive(), { type: 'permission_request', id: 'ask1', toolName: 'AskUserQuestion', input: PROD_ASK_INPUT, hasSuggestions: false });
    s = applyLive(s, { type: 'permission_resolved', id: 'ask1', decision: 'answer', message: 'Escopo de tarefas autônomas' });
    expect(s.pending).toHaveLength(0);
    expect(s.resolvedPerms).toHaveLength(1);
    expect(s.resolvedPerms[0]).toMatchObject({ id: 'ask1', decision: 'answer', answer: 'Escopo de tarefas autônomas' });
    const ev = toConvEvents(s).find(e => e.kind === 'permission');
    expect(ev?.kind === 'permission' && ev.answer).toBe('Escopo de tarefas autônomas');
  });
  it('hello traz status e pendências mantendo o input já conhecido', () => {
    let s = applyLive(emptyLive(), { type: 'permission_request', id: 'p', toolName: 'Bash', input: { command: 'x' }, hasSuggestions: false });
    s = applyLive(s, { type: 'hello', status: 'waiting', pending: [{ id: 'p', toolName: 'Bash' }] });
    expect(s.pending[0].input).toEqual({ command: 'x' });
  });
  it('erro aparece e some ao voltar a rodar', () => {
    let s = applyLive(emptyLive(), { type: 'error', message: 'boom' });
    s = applyLive(s, { type: 'status', status: 'error' });
    expect(toConvEvents(s).at(-1)).toMatchObject({ kind: 'result', ok: false });
    s = applyLive(s, { type: 'status', status: 'running' });
    expect(s.error).toBeNull();
  });
  it('stop manual ao vivo (sem reload): o parcial já acumulado no streaming vira o texto interrompido, tagueado, e nunca conflita com erro genuíno', () => {
    let s = applyLive(emptyLive(), { type: 'status', status: 'running' });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Vou ' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'rodar' } } });
    expect(s.partialText).toBe('Vou rodar');
    s = applyLive(s, { type: 'interrupted', message: 'Interrompido pelo usuário', duringTool: false, partialText: 'Vou rodar', partialThinking: '' });
    expect(s.partialText).toBe('');
    expect(s.interrupted).toMatchObject({ message: 'Interrompido pelo usuário', duringTool: false, text: 'Vou rodar' });
    expect(s.error).toBeNull();
    const ev = toConvEvents(s);
    expect(ev.find(e => e.kind === 'text')).toMatchObject({ text: 'Vou rodar', interrupted: 'Interrompido' });
    // status volta a idle (não error) e a interrupção continua visível — é o comportamento certo.
    s = applyLive(s, { type: 'status', status: 'idle' });
    expect(s.interrupted).not.toBeNull();
  });
  it('novo turno rodando limpa a interrupção do turno anterior', () => {
    let s = applyLive(emptyLive(), { type: 'interrupted', message: 'x', duringTool: false, partialText: 'a', partialThinking: '' });
    expect(s.interrupted).not.toBeNull();
    s = applyLive(s, { type: 'status', status: 'running' });
    expect(s.interrupted).toBeNull();
  });
  it('evento desconhecido não altera nada', () => {
    const s = emptyLive();
    expect(applyLive(s, { type: 'zzz' })).toBe(s);
  });
});
