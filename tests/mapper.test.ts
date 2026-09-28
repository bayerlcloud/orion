import { describe, it, expect } from 'vitest';
import { describeTool, reduceSdkMessages, relativeTime, formatCost, formatDuration, estimateTokens, sumModelUsage, formatTokens, unifiedDiff, computeUsageBars, filterSessions, groupSessions, formatAskAnswer, foldExpiredPermissions } from '../web/src/claude/mapper';
import type { ConvEvent, SdkMessage, SessionSummary } from '../web/src/claude/types';

/** Payload real de um AskUserQuestion da sessão de produção "Esta ai?" (fcc5ee4b-96f2-45a5-baf3-78e9f1f71ecd,
 * claude_approvals.id = 8cddcaaa-9e86-4db9-a038-c967ff0af86f): uma pergunta com multiSelect e 4 opções. */
const PROD_ASK_QUESTIONS = [{
  header: 'Tipo de poder',
  question: "Quando você diz 'te dar mais poder', qual dessas frentes você quer destravar primeiro?",
  multiSelect: true,
  options: [
    { label: 'Permissões do Claude Code aqui no CLI', description: 'Menos prompts de confirmação para bash/edição neste ambiente (settings.json), sem chegar a --dangerously-skip-permissions' },
    { label: 'Acesso dentro do próprio Orion', description: 'O que o Central/painel Orion permite este agente fazer no sistema (rotas, projetos, contas conectadas)' },
    { label: 'Escopo de tarefas autônomas', description: 'Deixar eu tomar mais decisões sozinho durante implementações (menos perguntas, mais ação direta)' },
    { label: 'Outra coisa', description: "Explicar em texto livre o que você quer dizer com 'mais poder'" },
  ],
}];

describe('describeTool', () => {
  it('Bash usa a descrição e guarda o comando', () => {
    const d = describeTool('Bash', { command: 'ls -la', description: 'Lista arquivos' });
    expect(d).toEqual({ label: 'Bash', description: 'Lista arquivos', inputText: 'ls -la' });
  });
  it('Bash sem descrição mostra o comando', () => {
    expect(describeTool('Bash', { command: 'ls' }).description).toBe('ls');
  });
  it('ferramenta MCP vira "Servidor [tool]"', () => {
    expect(describeTool('mcp__hostinger__dns_upsert', { name: 'v2' }).label).toBe('Hostinger [dns_upsert]');
  });
  it('ferramenta desconhecida mostra o nome e o JSON', () => {
    const d = describeTool('Foo', { a: 1 });
    expect(d.label).toBe('Foo');
    expect(d.inputText).toContain('"a": 1');
  });
  it('AskUserQuestion nunca cai no fallback de JSON cru: inputText é um resumo legível', () => {
    const d = describeTool('AskUserQuestion', { questions: PROD_ASK_QUESTIONS });
    expect(d.label).toBe('Pergunta');
    expect(d.inputText).not.toContain('{');
    expect(d.inputText).not.toContain('multiSelect');
    expect(d.inputText).toBe('Tipo de poder');
  });
});

describe('formatAskAnswer', () => {
  it('uma pergunta só: mensagem é só o(s) valor(es) escolhido(s), sem o header', () => {
    expect(formatAskAnswer(PROD_ASK_QUESTIONS, [['Permissões do Claude Code aqui no CLI']]))
      .toBe('Permissões do Claude Code aqui no CLI');
  });
  it('multiSelect: junta os labels marcados por vírgula (nunca json)', () => {
    const msg = formatAskAnswer(PROD_ASK_QUESTIONS, [['Permissões do Claude Code aqui no CLI', 'Escopo de tarefas autônomas']]);
    expect(msg).toBe('Permissões do Claude Code aqui no CLI, Escopo de tarefas autônomas');
    expect(msg).not.toContain('{');
    expect(msg).not.toContain('"label"');
  });
  it('várias perguntas: uma linha "header: valor" por pergunta respondida', () => {
    const qs = [{ header: 'A', question: 'pa?', options: [] }, { header: 'B', question: 'pb?', options: [] }];
    expect(formatAskAnswer(qs, [['x'], ['y', 'z']])).toBe('A: x\nB: y, z');
  });
  it('pergunta sem seleção fica de fora (não vira "header: ")', () => {
    const qs = [{ header: 'A', question: 'pa?', options: [] }, { header: 'B', question: 'pb?', options: [] }];
    expect(formatAskAnswer(qs, [[], ['y']])).toBe('B: y');
  });
  it('aceita texto livre no lugar de uma seleção', () => {
    expect(formatAskAnswer(PROD_ASK_QUESTIONS, ['minha resposta livre'])).toBe('minha resposta livre');
  });
});

describe('foldExpiredPermissions', () => {
  const perm = (id: string, decision?: string, extra: Partial<Extract<ConvEvent, { kind: 'permission' }>> = {}): ConvEvent =>
    ({ id, kind: 'permission', toolUseId: id, name: 'Bash', label: 'Bash', description: '', inputText: '', decision: decision as any, ...extra });

  it('não mexe quando não há timeouts', () => {
    const events = [perm('a', 'allow'), perm('b')];
    expect(foldExpiredPermissions(events)).toEqual(events);
  });
  it('um único expirado isolado fica como está (sem contagem)', () => {
    const events = [perm('a', 'allow'), perm('b', 'timeout'), perm('c', 'allow')];
    const out = foldExpiredPermissions(events);
    expect(out).toHaveLength(3);
    expect(out[1].id).toBe('b');
    expect(out[1].kind === 'permission' && out[1].expiredGroupCount).toBeUndefined();
  });
  it('3 expirados consecutivos (Bash + 2 AskUserQuestion, como na sessão "Esta ai?") colapsam num só bubble', () => {
    // Reflete a sessão fcc5ee4b: um Bash e dois AskUserQuestion pendentes órfãos de uma janela de
    // restarts seguidos do servidor, todos aparecendo em sequência na cauda da linha do tempo.
    const events = [
      perm('9dc0ed00', 'timeout', { name: 'Bash' }),
      perm('8cddcaaa', 'timeout', { name: 'AskUserQuestion', questions: PROD_ASK_QUESTIONS }),
      perm('bfe20541', 'timeout', { name: 'AskUserQuestion', questions: PROD_ASK_QUESTIONS }),
      perm('603412f3', 'allow_always'),
    ];
    const out = foldExpiredPermissions(events);
    expect(out.map(e => e.id)).toEqual(['9dc0ed00', '603412f3']);
    expect(out[0]).toMatchObject({ id: '9dc0ed00', decision: 'timeout', expiredGroupCount: 3 });
  });
  it('expirados não-consecutivos (separados por algo resolvido) não colapsam', () => {
    const events = [perm('a', 'timeout'), perm('mid', 'allow'), perm('b', 'timeout'), perm('c', 'timeout')];
    const out = foldExpiredPermissions(events);
    expect(out.map(e => e.id)).toEqual(['a', 'mid', 'b']);
    expect(out[0].kind === 'permission' && out[0].expiredGroupCount).toBeUndefined();
    expect(out[2]).toMatchObject({ id: 'b', expiredGroupCount: 2 });
  });
});

describe('reduceSdkMessages', () => {
  const msgs: SdkMessage[] = [
    { type: 'system', subtype: 'init', model: 'claude-fable-5-1', cwd: '/srv/work/x' },
    { type: 'user', message: { content: 'cria um subdomínio' } },
    { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'Preciso criar um registro A.' },
      { type: 'text', text: 'Vou criar o registro.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'dig x', description: 'Verifica DNS' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'dig: command not found', is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'getent hosts x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '1.2.3.4 x' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Feito.' }] } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.04, duration_ms: 18400, num_turns: 4 },
  ];
  const ev = reduceSdkMessages(msgs);

  it('gera a sequência esperada de tipos', () => {
    expect(ev.map(e => e.kind)).toEqual(['system', 'user', 'thinking', 'text', 'tool', 'tool', 'text', 'result']);
  });
  it('liga o tool_result ao tool_use certo e marca erro', () => {
    const t1 = ev[4]; const t2 = ev[5];
    if (t1.kind !== 'tool' || t2.kind !== 'tool') throw new Error('tipo');
    expect(t1.status).toBe('failure'); expect(t1.output).toContain('not found'); expect(t1.description).toBe('Verifica DNS');
    expect(t2.status).toBe('success'); expect(t2.output).toBe('1.2.3.4 x');
  });
  it('ferramenta sem resultado fica em execução', () => {
    const e = reduceSdkMessages([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] } }]);
    expect(e[0].kind === 'tool' && e[0].status).toBe('running');
  });
  it('resultado carrega custo e duração', () => {
    const r = ev[ev.length - 1];
    expect(r.kind === 'result' && r.ok && r.costUsd).toBe(0.04);
  });
  it('resultado com erro marca ok=false e mensagem', () => {
    const r = reduceSdkMessages([{ type: 'result', subtype: 'error_max_turns', is_error: true }])[0];
    expect(r.kind === 'result' && !r.ok && r.error).toBe('error_max_turns');
  });
  it('ignora tool_result órfão e stream_event sem quebrar', () => {
    const e = reduceSdkMessages([
      { type: 'stream_event', event: {} },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nada', content: 'x' }] } },
    ]);
    expect(e).toEqual([]);
  });
});

describe('formatação', () => {
  it('tempo relativo', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now, now)).toBe('agora');
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2m');
    expect(relativeTime(now - 7 * 3_600_000, now)).toBe('7h');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d');
  });
  it('custo e duração', () => {
    expect(formatCost(0.0412)).toBe('US$ 0.0412');
    expect(formatCost(1.5)).toBe('US$ 1.50');
    expect(formatDuration(18400)).toBe('18 s');
    expect(formatDuration(125000)).toBe('2 min 5 s');
  });
});

describe('estimativa de tokens', () => {
  it('estimateTokens ≈ chars/4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('sumModelUsage soma entrada/saída de todos os modelos', () => {
    expect(sumModelUsage(undefined)).toBeUndefined();
    expect(sumModelUsage({})).toBeUndefined();
    expect(sumModelUsage({ a: { inputTokens: 10, outputTokens: 5 }, b: { inputTokens: 3 } })).toEqual({ input: 13, output: 5 });
  });
  it('formatTokens abrevia milhares e milhões', () => {
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(25000)).toBe('25k');
    expect(formatTokens(2_000_000)).toBe('2.0M');
  });
  it('result carrega tokens de modelUsage', () => {
    const r = reduceSdkMessages([{ type: 'result', subtype: 'success', total_cost_usd: 0.1, modelUsage: { m: { inputTokens: 100, outputTokens: 40 } } }])[0];
    expect(r.kind === 'result' && r.inputTokens).toBe(100);
    expect(r.kind === 'result' && r.outputTokens).toBe(40);
  });
});

describe('unifiedDiff', () => {
  it('marca linha trocada como del + add e mantém contexto', () => {
    const d = unifiedDiff('a\nb\nc', 'a\nx\nc');
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'ctx', text: 'c' },
    ]);
  });
  it('linhas só adicionadas viram add', () => {
    const d = unifiedDiff('a', 'a\nb');
    expect(d.filter(l => l.type === 'add')).toEqual([{ type: 'add', text: 'b' }]);
  });
});

describe('computeUsageBars', () => {
  it('soma janelas e converte custo em % contra referência, com clamp', () => {
    const bars = computeUsageBars([{ cost_5h: '2.5', cost_7d: '50', cost_total: '10' }]);
    expect(bars.map(b => b.label)).toEqual(['Sessão (5h)', 'Semanal (7 dias)', 'Limite Fable']);
    expect(bars[0].pct).toBe(50); // 2.5 / 5
    expect(bars[1].pct).toBe(100); // 50 / 25 → clamp
    expect(bars[2].pct).toBe(10); // 10 / 100
    expect(bars[0].sub).toBe('US$ 2.50');
  });
  it('agrega várias linhas de usuário', () => {
    const bars = computeUsageBars([{ cost_5h: 1, cost_7d: 0, cost_total: 0 }, { cost_5h: 1.5, cost_7d: 0, cost_total: 0 }]);
    expect(bars[0].pct).toBe(50); // (1 + 1.5) / 5
  });
});

describe('filterSessions', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const sessions: SessionSummary[] = [
    { id: 's1', title: '[Brandspace] Forms', status: 'running', updatedAt: now, project: 'brandspace', projectName: 'Brandspace' },
    { id: 's2', title: 'Subdomínio v2', status: 'idle', updatedAt: now, project: 'infra', projectName: 'Infraestrutura' },
    { id: 's3', title: 'Deploy da Central', status: 'waiting', updatedAt: now, project: 'orion', projectName: 'Orion' },
    { id: 's4', title: 'Sem projeto nenhum', status: 'idle', updatedAt: now },
  ];

  it('sem filtros devolve tudo', () => {
    expect(filterSessions(sessions, {})).toHaveLength(4);
  });

  it('filtra por termo no título, sem diferenciar maiúsculas', () => {
    const r = filterSessions(sessions, { term: 'forms' });
    expect(r.map(s => s.id)).toEqual(['s1']);
  });

  it('filtra por termo que bate no projeto (slug ou nome)', () => {
    expect(filterSessions(sessions, { term: 'infra' }).map(s => s.id)).toEqual(['s2']);
    expect(filterSessions(sessions, { term: 'orion' }).map(s => s.id)).toEqual(['s3']);
  });

  it('filtra por projeto exato (slug)', () => {
    expect(filterSessions(sessions, { project: 'brandspace' }).map(s => s.id)).toEqual(['s1']);
  });

  it('activeOnly só deixa passar running/waiting', () => {
    expect(filterSessions(sessions, { activeOnly: true }).map(s => s.id)).toEqual(['s1', 's3']);
  });

  it('combina termo e projeto', () => {
    expect(filterSessions(sessions, { term: 'deploy', project: 'orion' }).map(s => s.id)).toEqual(['s3']);
    expect(filterSessions(sessions, { term: 'deploy', project: 'infra' })).toHaveLength(0);
  });
});

describe('groupSessions', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const day = 86_400_000;
  const sessions: SessionSummary[] = [
    { id: 's1', title: 'A', status: 'running', updatedAt: now, project: 'brandspace', projectName: 'Brandspace' },
    { id: 's2', title: 'B', status: 'idle', updatedAt: now, project: 'infra', projectName: 'Infraestrutura' },
    { id: 's3', title: 'C', status: 'idle', updatedAt: now - day, project: 'brandspace', projectName: 'Brandspace' },
    { id: 's4', title: 'D', status: 'idle', updatedAt: now - 3 * day, project: 'orion', projectName: 'Orion' },
    { id: 's5', title: 'E', status: 'idle', updatedAt: now - 10 * day },
  ];

  it("'none' devolve um único grupo 'Sem grupo' com todas as sessões, na ordem original", () => {
    const g = groupSessions(sessions, 'none', now);
    expect(g).toHaveLength(1);
    expect(g[0]).toEqual({ key: 'all', label: 'Sem grupo', sessions });
  });

  it("'none' com lista vazia ainda devolve o grupo (contagem zero)", () => {
    const g = groupSessions([], 'none', now);
    expect(g).toEqual([{ key: 'all', label: 'Sem grupo', sessions: [] }]);
  });

  it("'project' agrupa por slug, com rótulo do projeto, ordenado alfabeticamente", () => {
    const g = groupSessions(sessions, 'project', now);
    expect(g.map(x => x.label)).toEqual(['Brandspace', 'Infraestrutura', 'Orion', 'Sem projeto']);
    expect(g.find(x => x.key === 'brandspace')?.sessions.map(s => s.id)).toEqual(['s1', 's3']);
  });

  it("'recency' separa Hoje/Ontem/Esta semana/Mais antigas e some com baldes vazios", () => {
    const g = groupSessions(sessions, 'recency', now);
    expect(g.map(x => x.key)).toEqual(['today', 'yesterday', 'week', 'older']);
    expect(g.find(x => x.key === 'today')?.sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(g.find(x => x.key === 'yesterday')?.sessions.map(s => s.id)).toEqual(['s3']);
    expect(g.find(x => x.key === 'week')?.sessions.map(s => s.id)).toEqual(['s4']);
    expect(g.find(x => x.key === 'older')?.sessions.map(s => s.id)).toEqual(['s5']);
  });

  it("'recency' sem sessões antigas não mostra o balde 'Mais antigas'", () => {
    const g = groupSessions([sessions[0]], 'recency', now);
    expect(g.map(x => x.key)).toEqual(['today']);
  });
});
