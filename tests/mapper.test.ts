import { describe, it, expect } from 'vitest';
import { describeTool, reduceSdkMessages, relativeTime, formatCost, formatDuration, estimateTokens, sumModelUsage, formatTokens, unifiedDiff, computeUsageBars, computeRealUsageBars, formatResetIn, filterSessions, groupSessions, formatAskAnswer, foldExpiredPermissions, charDiff, charDiffIfSimilar, annotateCharDiffs, parseTodos, taskStatusLabel } from '../web/src/claude/mapper';
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
  // Task: nome real da tool no SDK é "Task" (não "Agent") — confirmado em webview/index.js v2.1.282
  // (`var RE="Task"`) e no schema real (`AgentInput` em sdk-tools.d.ts). A extensão mapeia esse nome
  // internamente para o renderer "Agent" (`$==="Task"?"Agent":$`) e mostra "Agent: {description}" no
  // cabeçalho (`class jD1{name="Agent";header(){...}}`), com o prompt como corpo IN.
  it('Task usa rótulo "Agent" (como a extensão real) e o prompt como inputText', () => {
    const d = describeTool('Task', { description: 'Corrige o build', prompt: 'Rode npm run build e corrija os erros', subagent_type: 'general-purpose' });
    expect(d).toEqual({ label: 'Agent', description: 'Corrige o build', inputText: 'Rode npm run build e corrija os erros' });
  });
  // TodoWrite: cabeçalho real é sempre o texto fixo "Update Todos" (`class wD1{name=Vw;header(){...}}`,
  // webview/index.js v2.1.282) — nunca dinâmico. Preview em PT-BR (mesma convenção de AskUserQuestion→"Pergunta").
  describe('TodoWrite', () => {
    it('rótulo "Lista de tarefas" com contagem de itens (plural)', () => {
      const d = describeTool('TodoWrite', { todos: [
        { content: 'a', status: 'pending', activeForm: 'A' },
        { content: 'b', status: 'completed', activeForm: 'B' },
      ] });
      expect(d.label).toBe('Lista de tarefas');
      expect(d.description).toBe('2 itens');
    });
    it('um item só: singular', () => {
      const d = describeTool('TodoWrite', { todos: [{ content: 'a', status: 'pending', activeForm: 'A' }] });
      expect(d.description).toBe('1 item');
    });
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
  // Ponta a ponta (mensagens do SDK → ConvEvent) pros dois gaps de paridade: confirma que o `input`
  // bruto do TodoWrite chega intacto no evento (é o que a Timeline usa com `parseTodos`) e que o
  // Task já sai com o rótulo/descrição/inputText certos (via describeTool) mesmo antes da Timeline
  // decidir a renderização dedicada.
  it('TodoWrite carrega o input.todos intacto no evento tool', () => {
    const todos = [{ content: 'a', status: 'pending', activeForm: 'A' }, { content: 'b', status: 'completed', activeForm: 'B' }];
    const e = reduceSdkMessages([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] } }])[0];
    expect(e.kind === 'tool' && e.name).toBe('TodoWrite');
    expect(e.kind === 'tool' && e.input).toEqual({ todos });
  });
  it('Task sai com label "Agent", description e inputText do prompt', () => {
    const e = reduceSdkMessages([{ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Investiga o bug', prompt: 'Reproduza e ache a causa raiz', subagent_type: 'general-purpose' } },
    ] } }])[0];
    expect(e.kind === 'tool' && e.label).toBe('Agent');
    expect(e.kind === 'tool' && e.description).toBe('Investiga o bug');
    expect(e.kind === 'tool' && e.inputText).toBe('Reproduza e ache a causa raiz');
    expect(e.kind === 'tool' && e.status).toBe('running');
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

/**
 * Destaque de caracteres dentro de uma linha trocada — igual ao que a extensão real mostra: ela usa
 * o editor de diff do Monaco por baixo (webview/index.js v2.1.282), e as classes de decoração
 * `char-insert`/`char-delete` (achadas junto de `diff-review-row`/`line-insert`/`line-delete`, ou
 * seja, é DE FATO o widget completo do Monaco, não um highlight simples) marcam INTERVALOS DE
 * CARACTERES dentro da linha — não palavras inteiras. O CSS confirma a granularidade: `.char-insert`
 * e `.char-delete` pintam o fundo por cima de qualquer seleção de caracteres, e a view inline usa
 * `.inline-deleted-text{text-decoration:line-through}` para o texto removido. Reimplementamos essa
 * granularidade (caractere, via LCS) sem o widget inteiro do Monaco (gutters, minimapa, linhas de
 * revisão para acessibilidade) — isso é reconhecidamente fora de escopo (ver PARIDADE.md).
 */
describe('charDiff', () => {
  it('linha idêntica: tudo contexto, nada destacado', () => {
    const { oldParts, newParts } = charDiff('const x = 1;', 'const x = 1;');
    expect(oldParts).toEqual([{ type: 'ctx', text: 'const x = 1;' }]);
    expect(newParts).toEqual([{ type: 'ctx', text: 'const x = 1;' }]);
  });
  it('troca de um trecho no meio: destaca só o trecho trocado, mantém prefixo/sufixo como contexto', () => {
    const { oldParts, newParts } = charDiff('const x = 1;', 'const x = 2;');
    expect(oldParts).toEqual([{ type: 'ctx', text: 'const x = ' }, { type: 'del', text: '1' }, { type: 'ctx', text: ';' }]);
    expect(newParts).toEqual([{ type: 'ctx', text: 'const x = ' }, { type: 'add', text: '2' }, { type: 'ctx', text: ';' }]);
  });
  it('duas trocas separadas na mesma linha: cada uma vira seu próprio trecho', () => {
    const { oldParts } = charDiff('foo(1, 2)', 'foo(9, 8)');
    expect(oldParts.filter(p => p.type === 'del').map(p => p.text)).toEqual(['1', '2']);
  });
  it('linhas sem nenhum caractere em comum: tudo del de um lado, tudo add do outro', () => {
    const { oldParts, newParts } = charDiff('abc', 'xyz');
    expect(oldParts).toEqual([{ type: 'del', text: 'abc' }]);
    expect(newParts).toEqual([{ type: 'add', text: 'xyz' }]);
  });
});

describe('charDiffIfSimilar', () => {
  it('linhas parecidas (edição pequena): devolve os trechos de char', () => {
    const d = charDiffIfSimilar('const x = 1;', 'const x = 2;');
    expect(d).toBeDefined();
    expect(d!.oldParts.some(p => p.type === 'del')).toBe(true);
    expect(d!.newParts.some(p => p.type === 'add')).toBe(true);
  });
  it('linhas totalmente diferentes (não é a mesma linha editada): undefined, sem destaque de char', () => {
    expect(charDiffIfSimilar('const x = 1;', 'return fetch(url).then(r => r.json());')).toBeUndefined();
  });
  it('uma das linhas vazia (não é uma edição, é add/del puro): undefined', () => {
    expect(charDiffIfSimilar('', 'algo novo')).toBeUndefined();
    expect(charDiffIfSimilar('algo antigo', '')).toBeUndefined();
  });
});

describe('annotateCharDiffs', () => {
  it('linha trocada (del seguido de add, parecidas): as duas ganham parts', () => {
    const out = annotateCharDiffs(unifiedDiff('const x = 1;', 'const x = 2;'));
    const del = out.find(l => l.type === 'del')!;
    const add = out.find(l => l.type === 'add')!;
    expect(del.parts?.some(p => p.type === 'del')).toBe(true);
    expect(add.parts?.some(p => p.type === 'add')).toBe(true);
  });
  it('del/add de linhas muito diferentes: nenhuma ganha parts (fica só o destaque de linha)', () => {
    const out = annotateCharDiffs(unifiedDiff('const x = 1;', 'return fetch(url).then(r => r.json());'));
    expect(out.every(l => l.parts === undefined)).toBe(true);
  });
  it('adição pura (sem del correspondente): não ganha parts', () => {
    const out = annotateCharDiffs(unifiedDiff('a', 'a\nb'));
    expect(out.find(l => l.type === 'add')?.parts).toBeUndefined();
  });
  it('remoção pura (sem add correspondente): não ganha parts', () => {
    const out = annotateCharDiffs(unifiedDiff('a\nb', 'a'));
    expect(out.find(l => l.type === 'del')?.parts).toBeUndefined();
  });
  it('não muda a lista original de unifiedDiff (pura, sem mutação)', () => {
    const lines = unifiedDiff('const x = 1;', 'const x = 2;');
    const before = JSON.stringify(lines);
    annotateCharDiffs(lines);
    expect(JSON.stringify(lines)).toBe(before);
  });
});

describe('computeUsageBars', () => {
  it('soma janelas e converte custo em % contra referência, com clamp', () => {
    const bars = computeUsageBars([{ cost_5h: '2.5', cost_7d: '50', cost_total: '10' }]);
    expect(bars.map(b => b.label)).toEqual(['Sessão (5h)', 'Semanal (7 dias)', 'Limite Fable']);
    expect(bars[0].pct).toBe(50); // 2.5 / 5
    expect(bars[1].pct).toBe(100); // 50 / 25 → clamp
    expect(bars[2].pct).toBe(10); // 10 / 100
    expect(bars[0].sub).toBeUndefined();
  });
  it('agrega várias linhas de usuário', () => {
    const bars = computeUsageBars([{ cost_5h: 1, cost_7d: 0, cost_total: 0 }, { cost_5h: 1.5, cost_7d: 0, cost_total: 0 }]);
    expect(bars[0].pct).toBe(50); // (1 + 1.5) / 5
  });
  it('com dados reais (rate_limits do SDK), usa os reais em vez do proxy por custo', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const real = { subscription_type: 'max' as string | null, rate_limits: { five_hour: { utilization: 79, resets_at: '2026-09-28T15:00:00Z' }, seven_day: { utilization: 12, resets_at: '2026-10-05T00:00:00Z' } } };
    const bars = computeUsageBars([{ cost_5h: '999', cost_7d: '999', cost_total: '999' }], real, now);
    expect(bars.map(b => b.label)).toEqual(['Sessão (5h)', 'Semanal (7 dias)']);
    expect(bars[0].pct).toBe(79);
    expect(bars[0].sub).toBeUndefined();
    expect(bars[0].resetText).toBe('em 3h');
  });
  it('sem dados reais, cai para o proxy por custo (comportamento de hoje)', () => {
    const bars = computeUsageBars([{ cost_5h: '2.5', cost_7d: '0', cost_total: '0' }], null);
    expect(bars[0].sub).toBeUndefined();
    expect(bars[0].resetText).toBeUndefined();
  });
});

describe('formatResetIn', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  it('sem resets_at, devolve undefined (nunca inventa)', () => {
    expect(formatResetIn(undefined, now)).toBeUndefined();
    expect(formatResetIn(null, now)).toBeUndefined();
  });
  it('data inválida devolve undefined', () => {
    expect(formatResetIn('não é uma data', now)).toBeUndefined();
  });
  it('já passou ou é agora: "em breve"', () => {
    expect(formatResetIn('2026-09-28T11:00:00Z', now)).toBe('em breve');
    expect(formatResetIn('2026-09-28T12:00:00Z', now)).toBe('em breve');
  });
  it('menos de 1h: minutos', () => {
    expect(formatResetIn('2026-09-28T12:45:00Z', now)).toBe('em 45m');
  });
  it('menos de 24h: horas', () => {
    expect(formatResetIn('2026-09-28T15:00:00Z', now)).toBe('em 3h');
  });
  it('24h ou mais: dias', () => {
    expect(formatResetIn('2026-10-01T12:00:00Z', now)).toBe('em 3d');
  });
});

describe('computeRealUsageBars', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  it('sem rate_limits (null), devolve lista vazia', () => {
    expect(computeRealUsageBars(null, 'max', now)).toEqual([]);
  });
  it('monta Session (5hr) e Weekly (7 day) a partir de five_hour/seven_day', () => {
    const bars = computeRealUsageBars({ five_hour: { utilization: 79, resets_at: '2026-09-28T15:00:00Z' }, seven_day: { utilization: 12.4, resets_at: null } }, 'max', now);
    expect(bars).toEqual([
      { key: '5h', label: 'Sessão (5h)', pct: 79, resetText: 'em 3h' },
      { key: '7d', label: 'Semanal (7 dias)', pct: 12, resetText: undefined },
    ]);
  });
  it('janela com utilization null é omitida (a extensão real também pula)', () => {
    const bars = computeRealUsageBars({ five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 5, resets_at: null } }, 'max', now);
    expect(bars.map(b => b.key)).toEqual(['7d']);
  });
  it('Weekly Sonnet só aparece em plano max/team/desconhecido (espelha a extensão real)', () => {
    const withSonnet = { five_hour: null, seven_day: null, seven_day_sonnet: { utilization: 30, resets_at: null } };
    expect(computeRealUsageBars(withSonnet, 'max', now).map(b => b.label)).toEqual(['Semanal Sonnet']);
    expect(computeRealUsageBars(withSonnet, 'team', now).map(b => b.label)).toEqual(['Semanal Sonnet']);
    expect(computeRealUsageBars(withSonnet, null, now).map(b => b.label)).toEqual(['Semanal Sonnet']);
    expect(computeRealUsageBars(withSonnet, 'pro', now).map(b => b.label)).toEqual([]);
  });
  it('model_scoped vira uma barra "Semanal {display_name}" por entrada (é daí que vem "Fable")', () => {
    const real = { five_hour: null, seven_day: null, model_scoped: [{ display_name: 'Fable', utilization: 45, resets_at: '2026-09-28T13:00:00Z' }] };
    const bars = computeRealUsageBars(real, 'max', now);
    expect(bars).toEqual([{ key: 'model-0', label: 'Semanal Fable', pct: 45, resetText: 'em 1h' }]);
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

/**
 * Leitura do input do TodoWrite (`{ todos: [{content, status, activeForm}] }` — schema real em
 * `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`, interface `TodoWriteInput`). A extensão real só usa
 * `content` e `status` na tela (função `gG0`/checkbox `J65` em webview/index.js v2.1.282) — `activeForm`
 * existe no schema mas não aparece na UI, então não carregamos ele adiante (nada pra exibir).
 */
describe('parseTodos', () => {
  it('lê content e status de cada item de input.todos', () => {
    const input = { todos: [
      { content: 'Ler o PARIDADE.md', status: 'completed', activeForm: 'Lendo o PARIDADE.md' },
      { content: 'Implementar diff de char', status: 'in_progress', activeForm: 'Implementando diff de char' },
      { content: 'Escrever testes', status: 'pending', activeForm: 'Escrevendo testes' },
    ] };
    expect(parseTodos(input)).toEqual([
      { content: 'Ler o PARIDADE.md', status: 'completed' },
      { content: 'Implementar diff de char', status: 'in_progress' },
      { content: 'Escrever testes', status: 'pending' },
    ]);
  });
  it('sem todos (input vazio, undefined ou todos não é array): lista vazia', () => {
    expect(parseTodos({})).toEqual([]);
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos({ todos: 'não é array' })).toEqual([]);
  });
  it('status desconhecido ou ausente vira pending (defensivo)', () => {
    expect(parseTodos({ todos: [{ content: 'x' }] })).toEqual([{ content: 'x', status: 'pending' }]);
    expect(parseTodos({ todos: [{ content: 'x', status: 'algo-invalido' }] })).toEqual([{ content: 'x', status: 'pending' }]);
  });
});

/**
 * Rótulo de status de um Task/Agent (subagente) na linha do tempo — "rodando/concluído", pedido
 * explicitamente no gap de paridade (a extensão real não expõe esse texto exato; aqui é nosso jeito
 * de mostrar o `ToolStatus` que já temos, sem inventar telemetria ao vivo — tempo decorrido/contagem
 * de tool calls do subagente — que a extensão real tem (`iU0`/`lU0` no webview) mas exigiria um
 * stream de progresso por tarefa que o Orion não tem hoje).
 */
describe('taskStatusLabel', () => {
  it('running vira texto de progresso', () => {
    expect(taskStatusLabel('running')).toBe('Executando…');
  });
  it('success vira "Concluído"', () => {
    expect(taskStatusLabel('success')).toBe('Concluído');
  });
  it('failure vira "Falhou"', () => {
    expect(taskStatusLabel('failure')).toBe('Falhou');
  });
  it('warning cai no mesmo texto de concluído (fallback)', () => {
    expect(taskStatusLabel('warning')).toBe('Concluído');
  });
});
