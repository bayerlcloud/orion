import { describe, it, expect } from 'vitest';
import { describeTool, reduceSdkMessages, relativeTime, formatCost, formatDuration, estimateTokens, sumModelUsage, formatTokens, unifiedDiff, computeUsageBars, computeRealUsageBars, formatResetIn, filterSessions, groupSessions, formatAskAnswer, foldExpiredPermissions, currentPermission, charDiff, charDiffIfSimilar, annotateCharDiffs, parseTodos, taskStatusLabel, interruptedLabel, messageHistory, cycleMessageIndex, SPINNER_GLYPHS, SPINNER_GLYPH_SEQUENCE, spinnerGlyphAt, SPINNER_WORDS, spinnerWordDelayMs, pickSpinnerWord, toolRunningLabel, applyPendingToolWaitStatus, attachmentImageUrl, parseAgentTaskUsage, noteAgentTask, agentTaskDuration, formatAgentDuration, sumSessionTokens, agentTaskList, validateWorktreeName, sessionWorktreeName, validateGroupName } from '../web/src/claude/mapper';
import { matchModelAlias, matchEffort } from '../web/src/claude/api';
import type { ConvEvent, SdkMessage, SessionSummary, AgentTask, SessionGroupInfo } from '../web/src/claude/types';

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

describe('currentPermission', () => {
  const perm = (id: string, decision?: string, extra: Partial<Extract<ConvEvent, { kind: 'permission' }>> = {}): ConvEvent =>
    ({ id, kind: 'permission', toolUseId: id, name: 'Bash', label: 'Bash', description: '', inputText: '', decision: decision as any, ...extra });
  const text = (id: string): ConvEvent => ({ id, kind: 'text', text: 'oi' });

  it('sem nenhum pedido de permissão: undefined', () => {
    expect(currentPermission([text('a')])).toBeUndefined();
  });
  it('só pedidos já resolvidos (allow/deny/allow_always/answer): undefined — nenhum fica docado', () => {
    const events = [perm('a', 'allow'), perm('b', 'deny'), perm('c', 'allow_always'), perm('d', 'answer')];
    expect(currentPermission(events)).toBeUndefined();
  });
  it('só pedidos expirados (timeout): undefined — esses continuam na linha do tempo (foldExpiredPermissions), não no card docado', () => {
    expect(currentPermission([perm('a', 'timeout')])).toBeUndefined();
  });
  it('um único pedido pendente: esse mesmo', () => {
    const p = perm('a');
    expect(currentPermission([p])).toBe(p);
  });
  /**
   * server/claude/runner.ts: `l.pending` é um `Map<string, Pending>` sem NENHUMA serialização — cada
   * chamada de `canUseTool` do SDK ganha sua própria entrada (`pid = randomUUID()`), então nada no
   * runner impede duas (ou mais) chamadas simultâneas ficarem pendentes ao mesmo tempo, se o SDK
   * despachar tool_use independentes em paralelo no mesmo turno (ver teste novo em runner.test.ts que
   * prova isso na prática, não só por leitura de código). A extensão real trata isso exatamente assim
   * — `permissionRequests` também é uma lista lá — e o componente docado sempre lê só `[0]`
   * (confirmado lendo webview/index.js v2.1.282: `N=$.permissionRequests.value[0]`, dentro do render
   * de `inputContainer`); os demais ficam na fila, invisíveis, até o primeiro ser decidido. Aqui:
   * primeiro evento `permission` sem `decision` nenhuma, na ordem em que aparece no array (mesma
   * ordem de `s.pending` em live.ts — FIFO, o pedido mais antigo ainda esperando).
   */
  it('dois pedidos pendentes ao mesmo tempo: mostra só o 1º (FIFO) — o 2º fica de fora, igual à extensão real (permissionRequests.value[0])', () => {
    const p1 = perm('a'); const p2 = perm('b');
    expect(currentPermission([p1, p2])).toBe(p1);
  });
  it('mistura resolvido + pendente: pula o resolvido e acha o pendente', () => {
    const resolved = perm('a', 'allow'); const pending = perm('b');
    expect(currentPermission([resolved, pending])).toBe(pending);
  });
  it('mistura expirado + pendente: pula o expirado (fica na timeline) e acha o pendente (vai pro card docado)', () => {
    const expired = perm('a', 'timeout'); const pending = perm('b');
    expect(currentPermission([expired, pending])).toBe(pending);
  });
  it('entremeado com outros tipos de evento (texto, etc.): acha a permissão pendente certa, ignorando o resto', () => {
    const p = perm('a');
    expect(currentPermission([text('x'), perm('resolved', 'deny'), text('y'), p])).toBe(p);
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
 * Pastas nomeadas manuais (ver PARIDADE.md, item 12 da seção 13) — diferente dos critérios acima
 * ('project'/'recency'), que são automáticos e derivados só das sessões: aqui os grupos em si são
 * uma lista à parte, persistida (`SessionGroupInfo[]`, vinda de `GET /api/claude/session-groups`),
 * então `groupSessions` precisa receber essa lista pra saber quais pastas existem — inclusive as
 * vazias, que uma sessão sozinha nunca revelaria (diferente de 'project', onde um grupo só aparece
 * se pelo menos uma sessão tiver aquele projeto).
 */
describe("groupSessions — 'folder' (pastas nomeadas)", () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const sessions: SessionSummary[] = [
    { id: 's1', title: 'A', status: 'running', updatedAt: now, groupId: 'g1' },
    { id: 's2', title: 'B', status: 'idle', updatedAt: now, groupId: 'g2' },
    { id: 's3', title: 'C', status: 'idle', updatedAt: now, groupId: 'g1' },
    { id: 's4', title: 'D', status: 'idle', updatedAt: now },
    // groupId aponta pra uma pasta que não existe mais na lista de `folders` (apagada) — deve cair em "Sem pasta", não sumir.
    { id: 's5', title: 'E', status: 'idle', updatedAt: now, groupId: 'pasta-apagada' },
  ];
  const folders: SessionGroupInfo[] = [
    { id: 'g1', name: 'Trabalho', createdAt: now - 2000 },
    { id: 'g2', name: 'Pessoal', createdAt: now - 1000 },
  ];

  it('uma seção por pasta, na ordem de criação, com "Sem pasta" sempre por último', () => {
    const g = groupSessions(sessions, 'folder', now, folders);
    expect(g.map(x => x.key)).toEqual(['folder:g1', 'folder:g2', 'ungrouped']);
    expect(g.map(x => x.label)).toEqual(['Trabalho', 'Pessoal', 'Sem pasta']);
  });

  it('cada sessão vai pra pasta do seu groupId', () => {
    const g = groupSessions(sessions, 'folder', now, folders);
    expect(g.find(x => x.key === 'folder:g1')?.sessions.map(s => s.id)).toEqual(['s1', 's3']);
    expect(g.find(x => x.key === 'folder:g2')?.sessions.map(s => s.id)).toEqual(['s2']);
  });

  it('sessão sem groupId OU com groupId de pasta apagada cai em "Sem pasta"', () => {
    const g = groupSessions(sessions, 'folder', now, folders);
    expect(g.find(x => x.key === 'ungrouped')?.sessions.map(s => s.id)).toEqual(['s4', 's5']);
  });

  it('pasta recém-criada sem sessão nenhuma ainda aparece vazia (não é derivada das sessões)', () => {
    const emptyFolders: SessionGroupInfo[] = [{ id: 'g3', name: 'Vazia', createdAt: now }];
    const g = groupSessions([], 'folder', now, emptyFolders);
    expect(g.map(x => x.key)).toEqual(['folder:g3', 'ungrouped']);
    expect(g.find(x => x.key === 'folder:g3')?.sessions).toEqual([]);
  });

  it('sem nenhuma pasta cadastrada, devolve só "Sem pasta" com tudo dentro', () => {
    const g = groupSessions(sessions, 'folder', now, []);
    expect(g).toEqual([{ key: 'ungrouped', label: 'Sem pasta', sessions }]);
  });
});

/**
 * Validação do nome de uma pasta — mesmo limite (120 caracteres) e mesma regra ("vazio depois de
 * trim é inválido") já usados por `POST /api/claude/sessions/:id/rename` (server/routes/claude.ts:
 * `title.trim().slice(0, 120)`), reaproveitado aqui em vez de inventar um limite novo. Cópia do lado
 * cliente da validação autoritativa do servidor (`server/claude/groups.ts`, `validateGroupName`) —
 * mesmo padrão já usado por `validateWorktreeName` (client mirror, nunca a fonte da verdade).
 */
describe('validateGroupName', () => {
  it('nome vazio ou só espaço é inválido', () => {
    expect(validateGroupName('')).toBeTruthy();
    expect(validateGroupName('   ')).toBeTruthy();
  });

  it('nome válido (com espaço nas pontas) devolve null', () => {
    expect(validateGroupName('  Trabalho  ')).toBeNull();
  });

  it('limite de 120 caracteres: 121 é inválido, 120 é válido', () => {
    expect(validateGroupName('a'.repeat(121))).toBeTruthy();
    expect(validateGroupName('a'.repeat(120))).toBeNull();
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
  it('waiting (permissão pendente, ver applyPendingToolWaitStatus) vira "Aguardando permissão…" — nunca "Concluído" (bug que essa entrada evita reintroduzir)', () => {
    expect(taskStatusLabel('waiting')).toBe('Aguardando permissão…');
  });
});

describe('interruptedLabel', () => {
  it('sem ferramenta pendente no momento do stop: "Interrompido" (equivalente PT-BR de "Interrupted", tabela Qw da extensão real)', () => {
    expect(interruptedLabel(false)).toBe('Interrompido');
  });
  it('com ferramenta pendente no momento do stop: "Ferramenta interrompida" (equivalente PT-BR de "Tool interrupted")', () => {
    expect(interruptedLabel(true)).toBe('Ferramenta interrompida');
  });
});

describe('messageHistory', () => {
  const ev = (id: string, text: string): ConvEvent => ({ id, kind: 'user', text });

  it('extrai só eventos de usuário, mais recente primeiro (ordem invertida)', () => {
    const events: ConvEvent[] = [ev('1', 'primeira'), ev('2', 'segunda'), ev('3', 'terceira')];
    expect(messageHistory(events)).toEqual(['terceira', 'segunda', 'primeira']);
  });

  it('ignora eventos que não são de usuário (texto do assistente, tool, etc.)', () => {
    const events: ConvEvent[] = [ev('1', 'oi'), { id: '2', kind: 'text', text: 'resposta do claude' }, ev('3', 'de novo')];
    expect(messageHistory(events)).toEqual(['de novo', 'oi']);
  });

  it('ignora texto vazio ou só espaço', () => {
    const events: ConvEvent[] = [ev('1', 'real'), ev('2', '   '), ev('3', '')];
    expect(messageHistory(events)).toEqual(['real']);
  });

  it('sem mensagens de usuário: lista vazia', () => {
    expect(messageHistory([{ id: '1', kind: 'system', text: 'início' }])).toEqual([]);
  });
});

describe('cycleMessageIndex', () => {
  const history = ['mais recente', 'do meio', 'mais antiga'];

  it('sem histórico: null em qualquer direção', () => {
    expect(cycleMessageIndex(-1, { index: -1, saved: '' }, [], 'rascunho')).toBeNull();
    expect(cycleMessageIndex(1, { index: -1, saved: '' }, [], '')).toBeNull();
  });

  it('ArrowUp pela 1ª vez: guarda o rascunho atual e mostra o item mais recente (índice 0)', () => {
    const r = cycleMessageIndex(-1, { index: -1, saved: '' }, history, 'meu rascunho');
    expect(r).toEqual({ index: 0, saved: 'meu rascunho', text: 'mais recente' });
  });

  it('ArrowUp de novo (já ciclando): avança pro item seguinte mais antigo, mantendo o rascunho salvo', () => {
    const r = cycleMessageIndex(-1, { index: 0, saved: 'meu rascunho' }, history, 'mais recente');
    expect(r).toEqual({ index: 1, saved: 'meu rascunho', text: 'do meio' });
  });

  it('ArrowUp no item mais antigo: não dá a volta — null', () => {
    const r = cycleMessageIndex(-1, { index: 2, saved: 'meu rascunho' }, history, 'mais antiga');
    expect(r).toBeNull();
  });

  it('ArrowDown fora de um ciclo (índice -1): não faz nada — null', () => {
    expect(cycleMessageIndex(1, { index: -1, saved: '' }, history, 'texto solto')).toBeNull();
  });

  it('ArrowDown a partir do meio: volta um item em direção ao mais recente', () => {
    const r = cycleMessageIndex(1, { index: 1, saved: 'meu rascunho' }, history, 'do meio');
    expect(r).toEqual({ index: 0, saved: 'meu rascunho', text: 'mais recente' });
  });

  it('ArrowDown no item mais recente (índice 0): restaura o rascunho original salvo, sai do ciclo (índice -1)', () => {
    const r = cycleMessageIndex(1, { index: 0, saved: 'meu rascunho' }, history, 'mais recente');
    expect(r).toEqual({ index: -1, saved: 'meu rascunho', text: 'meu rascunho' });
  });

  it('edição no meio do ciclo não contamina o rascunho restaurado: só o texto salvo no início da 1ª ArrowUp volta', () => {
    // Simula: ArrowUp (salva 'original'), usuário edita o item mostrado, ArrowDown de volta ao -1.
    const first = cycleMessageIndex(-1, { index: -1, saved: '' }, history, 'original')!;
    const r = cycleMessageIndex(1, { index: first.index, saved: first.saved }, history, 'texto editado no meio do ciclo, ignorado aqui');
    expect(r).toEqual({ index: -1, saved: 'original', text: 'original' });
  });
});

describe('matchModelAlias', () => {
  it('sem modelo (null/undefined/vazio): default', () => {
    expect(matchModelAlias(null)).toBe('default');
    expect(matchModelAlias(undefined)).toBe('default');
    expect(matchModelAlias('')).toBe('default');
  });

  it('alias exato', () => {
    expect(matchModelAlias('sonnet')).toBe('sonnet');
    expect(matchModelAlias('opus')).toBe('opus');
    expect(matchModelAlias('haiku')).toBe('haiku');
    expect(matchModelAlias('fable')).toBe('fable');
  });

  it('id canônico resolvido pelo SDK (o que o system/init realmente grava): casa por substring', () => {
    expect(matchModelAlias('claude-sonnet-5')).toBe('sonnet');
    expect(matchModelAlias('claude-opus-4-8')).toBe('opus');
    expect(matchModelAlias('claude-fable-5-1')).toBe('fable'); // valor real visto em fixtures.ts
    expect(matchModelAlias('claude-haiku-4-5')).toBe('haiku');
  });

  it('modelo desconhecido: cai pro default em vez de quebrar', () => {
    expect(matchModelAlias('gpt-5')).toBe('default');
  });
});

// Paridade de persistência de esforço (28/09/2026, rodada de follow-up ao vivo do Bayerl): igual
// matchModelAlias acima, mas pra claude_sessions.effort (nullable, sessão sem escolha explícita ou
// criada antes da coluna existir). Nunca confia cegamente no valor do banco; 'medium' é o mesmo
// padrão do useState<Effort>('medium') inicial em ClaudePage.tsx.
describe('matchEffort', () => {
  it('sem esforço (null/undefined/vazio): medium', () => {
    expect(matchEffort(null)).toBe('medium');
    expect(matchEffort(undefined)).toBe('medium');
    expect(matchEffort('')).toBe('medium');
  });

  it('valor válido: mantém', () => {
    expect(matchEffort('low')).toBe('low');
    expect(matchEffort('medium')).toBe('medium');
    expect(matchEffort('high')).toBe('high');
    expect(matchEffort('xhigh')).toBe('xhigh');
    expect(matchEffort('max')).toBe('max');
  });

  it('valor desconhecido/corrompido: cai pro medium em vez de quebrar', () => {
    expect(matchEffort('urgent')).toBe('medium');
    expect(matchEffort('LOW')).toBe('medium'); // case-sensitive de propósito — mesmos literais que EFFORTS valida no server
  });
});

describe('spinnerGlyphAt', () => {
  it('passo 0 é o menor glifo ("·"), primeiro da lista real sU0', () => {
    expect(spinnerGlyphAt(0)).toBe('·');
  });
  it('passo 2 é o asterisco literal "*" — exatamente o que o Bayerl descreveu ("asterisco pulsando")', () => {
    expect(spinnerGlyphAt(2)).toBe('*');
  });
  it('passo 5 é o maior glifo ("✽"), o pico do vai-e-volta', () => {
    expect(spinnerGlyphAt(5)).toBe('✽');
  });
  it('passo 6 já é a volta: repete o maior glifo (sequência espelhada, 12 passos: sU0 + reverse)', () => {
    expect(spinnerGlyphAt(6)).toBe('✽');
    expect(spinnerGlyphAt(7)).toBe('✻');
  });
  it('passo 10 é o penúltimo da volta (mesmo glifo do passo 1); passo 11 fecha o ciclo no menor glifo de novo (mesmo do passo 0)', () => {
    expect(spinnerGlyphAt(10)).toBe('✢');
    expect(spinnerGlyphAt(11)).toBe('·');
  });
  it('dá a volta no ciclo: passo 12 == passo 0', () => {
    expect(spinnerGlyphAt(12)).toBe(spinnerGlyphAt(0));
    expect(spinnerGlyphAt(120)).toBe(spinnerGlyphAt(0));
  });
  it('aceita passo negativo sem quebrar (módulo sempre positivo)', () => {
    expect(spinnerGlyphAt(-1)).toBe(spinnerGlyphAt(11));
    expect(spinnerGlyphAt(-12)).toBe(spinnerGlyphAt(0));
  });
  it('a sequência vai-e-volta tem 12 passos, ida + volta espelhada dos 6 glifos reais', () => {
    expect(SPINNER_GLYPH_SEQUENCE).toHaveLength(12);
    expect(SPINNER_GLYPHS).toHaveLength(6);
    expect([...SPINNER_GLYPH_SEQUENCE]).toEqual([...SPINNER_GLYPHS, ...[...SPINNER_GLYPHS].reverse()]);
  });
});

describe('SPINNER_WORDS', () => {
  it('84 palavras reais (lista VA1 extraída do webview decompilado v2.1.282, via json.loads)', () => {
    expect(SPINNER_WORDS).toHaveLength(84);
  });
  it('todas não-vazias, sem duplicata, e nenhuma tem espaço (são gerúndios/verbos de uma palavra só)', () => {
    expect(SPINNER_WORDS.every(w => w.length > 0)).toBe(true);
    expect(new Set(SPINNER_WORDS).size).toBe(SPINNER_WORDS.length);
    expect(SPINNER_WORDS.every(w => !w.includes(' '))).toBe(true);
  });
  it('inclui as palavras citadas no pedido original (achadas de verdade no bundle, não inventadas)', () => {
    expect(SPINNER_WORDS).toContain('Pondering');
    expect(SPINNER_WORDS).toContain('Marinating');
    expect(SPINNER_WORDS).toContain('Percolating');
  });
});

describe('spinnerWordDelayMs', () => {
  it('1ª troca: 2000ms', () => { expect(spinnerWordDelayMs(0)).toBe(2000); });
  it('2ª troca: 3000ms (5s desde o início)', () => { expect(spinnerWordDelayMs(1)).toBe(3000); });
  it('3ª troca: 5000ms (10s desde o início)', () => { expect(spinnerWordDelayMs(2)).toBe(5000); });
  it('4ª troca em diante: 5000ms (default, a cada 5s)', () => {
    expect(spinnerWordDelayMs(3)).toBe(5000);
    expect(spinnerWordDelayMs(10)).toBe(5000);
    expect(spinnerWordDelayMs(1000)).toBe(5000);
  });
});

describe('pickSpinnerWord', () => {
  it('rand=0: primeira palavra da lista', () => {
    expect(pickSpinnerWord(['a', 'b', 'c'], () => 0)).toBe('a');
  });
  it('rand perto de 1: última palavra da lista (nunca estoura o índice)', () => {
    expect(pickSpinnerWord(['a', 'b', 'c'], () => 0.999999)).toBe('c');
  });
  it('rand no meio: palavra do meio', () => {
    expect(pickSpinnerWord(['a', 'b', 'c'], () => 0.5)).toBe('b');
  });
  it('lista vazia: string vazia em vez de quebrar', () => {
    expect(pickSpinnerWord([], () => 0.5)).toBe('');
  });
  it('sem argumentos: sorteia da lista real SPINNER_WORDS', () => {
    const w = pickSpinnerWord();
    expect(SPINNER_WORDS).toContain(w);
  });
});

describe('toolRunningLabel', () => {
  it('running: "executando…"', () => {
    expect(toolRunningLabel('running')).toBe('executando…');
  });
  it('waiting (permissão pendente, ver applyPendingToolWaitStatus): "aguardando permissão…"', () => {
    expect(toolRunningLabel('waiting')).toBe('aguardando permissão…');
  });
});

/**
 * `applyPendingToolWaitStatus` — investigação de 28/09/2026 ("Bayerl: o padrão de mensagens tá
 * diferente do plugin", ver PARIDADE.md e a seção nova em "Timeline"). Grounding num exemplo real:
 * sessão de produção c4380a41-d263-408e-9543-4be08d1aea01, seq 29 (`assistant`, tool_use Bash, id
 * real `toolu_01Rt1vpAf4CECJztM2s5gdqZ`) seguido em seq 30 de um `permission_request` pro mesmo
 * comando (`grep -n -i "nível\|nivel\|root\|level" web/src/pages/SpecMemoria.tsx | head -60; ...`) —
 * antes desta correção, o bloco da ferramenta já mostrava "executando…" nesse intervalo, porque o
 * runner descartava o `toolUseID` real do SDK (não tinha como ligar os dois).
 */
describe('applyPendingToolWaitStatus', () => {
  const toolEvent = (overrides: Partial<Extract<ConvEvent, { kind: 'tool' }>> = {}): ConvEvent => ({
    id: 'e1', kind: 'tool', toolUseId: 'toolu_01Rt1vpAf4CECJztM2s5gdqZ', name: 'Bash', label: 'Bash',
    input: { command: 'grep -n -i "nível\\|nivel\\|root\\|level" web/src/pages/SpecMemoria.tsx | head -60' },
    inputText: 'grep -n -i "nível\\|nivel\\|root\\|level" web/src/pages/SpecMemoria.tsx | head -60',
    status: 'running', ...overrides,
  });

  it('sem ids pendentes: devolve a MESMA referência (evita re-render à toa)', () => {
    const events = [toolEvent()];
    expect(applyPendingToolWaitStatus(events, [])).toBe(events);
  });

  it('tool_use running com permissão pendente pro MESMO toolUseId real (caso real da sessão de produção, seq 29/30): vira waiting', () => {
    const events = [toolEvent()];
    const out = applyPendingToolWaitStatus(events, ['toolu_01Rt1vpAf4CECJztM2s5gdqZ']);
    expect(out).not.toBe(events);
    expect(out[0]).toMatchObject({ status: 'waiting' });
    // imutável: a lista original não muda
    expect(events[0]).toMatchObject({ status: 'running' });
  });

  it('toolUseId diferente (outro tool_use pendente, não este): não mexe, mesma referência de volta', () => {
    const events = [toolEvent()];
    const out = applyPendingToolWaitStatus(events, ['toolu_outro_completamente_diferente']);
    expect(out).toBe(events);
    expect(out[0]).toMatchObject({ status: 'running' });
  });

  it('já tem output (tool_result já chegou, status success): não regride pra waiting mesmo se o id ainda aparecer numa lista pendente desatualizada', () => {
    const events = [toolEvent({ status: 'success', output: 'ok' })];
    const out = applyPendingToolWaitStatus(events, ['toolu_01Rt1vpAf4CECJztM2s5gdqZ']);
    expect(out).toBe(events);
    expect(out[0]).toMatchObject({ status: 'success' });
  });

  it('status já failure/warning: não regride pra waiting', () => {
    const failure = applyPendingToolWaitStatus([toolEvent({ status: 'failure', output: 'erro' })], ['toolu_01Rt1vpAf4CECJztM2s5gdqZ']);
    expect(failure[0]).toMatchObject({ status: 'failure' });
    const warning = applyPendingToolWaitStatus([toolEvent({ status: 'warning', output: 'ok, com aviso' })], ['toolu_01Rt1vpAf4CECJztM2s5gdqZ']);
    expect(warning[0]).toMatchObject({ status: 'warning' });
  });

  it('eventos que não são tool (texto do usuário, por exemplo) passam intactos', () => {
    const userEvent: ConvEvent = { id: 'u1', kind: 'user', text: 'oi' };
    const events: ConvEvent[] = [userEvent, toolEvent()];
    const out = applyPendingToolWaitStatus(events, ['toolu_01Rt1vpAf4CECJztM2s5gdqZ']);
    expect(out[0]).toEqual(userEvent);
    expect(out[1]).toMatchObject({ status: 'waiting' });
  });

  it('aceita Set ou array de ids indistintamente', () => {
    const viaSet = applyPendingToolWaitStatus([toolEvent()], new Set(['toolu_01Rt1vpAf4CECJztM2s5gdqZ']));
    expect(viaSet[0]).toMatchObject({ status: 'waiting' });
  });

  it('várias ferramentas na mesma timeline: só a que bate com o id pendente muda', () => {
    const outra = toolEvent({ id: 'e2', toolUseId: 'toolu_outra_ferramenta', name: 'Read' });
    const out = applyPendingToolWaitStatus([toolEvent(), outra], ['toolu_01Rt1vpAf4CECJztM2s5gdqZ']);
    expect(out[0]).toMatchObject({ status: 'waiting' });
    expect(out[1]).toMatchObject({ status: 'running' });
  });
});

/**
 * URL da miniatura clicável de um anexo de imagem já enviado (Lightbox/Timeline.tsx, popup de
 * 28/09/2026 — ver PARIDADE.md). Só devolve algo quando dá pra reconstruir de verdade a imagem a
 * partir do que ficou persistido no evento `user_prompt` (kind + path + media_type); sem isso (kind
 * 'file', ou um anexo persistido ANTES desta rodada — sem `path`/`media_type`) devolve undefined e
 * quem chama cai pro chip só com ícone/nome de sempre, sem link nenhum — nunca um <img> quebrado.
 */
describe('attachmentImageUrl', () => {
  it('imagem com path e media_type: monta a URL do endpoint de anexos com os dois como query', () => {
    const url = attachmentImageUrl({ kind: 'image', media_type: 'image/png', path: '/srv/claude-uploads/1/x-foto.png' });
    expect(url).toBe('/api/claude/attachments?path=%2Fsrv%2Fclaude-uploads%2F1%2Fx-foto.png&type=image%2Fpng');
  });

  it('kind "file": nunca gera URL, mesmo com path/media_type presentes', () => {
    expect(attachmentImageUrl({ kind: 'file', media_type: 'application/pdf', path: '/u/a.pdf' })).toBeUndefined();
  });

  it('sem path (anexo persistido antes desta rodada, só metadados): undefined', () => {
    expect(attachmentImageUrl({ kind: 'image', media_type: 'image/png' })).toBeUndefined();
  });

  it('sem media_type: undefined (o endpoint exige "type" pra restringir o Content-Type servido)', () => {
    expect(attachmentImageUrl({ kind: 'image', path: '/u/a.png' })).toBeUndefined();
  });

  it('escapa caracteres especiais no caminho (espaço, acento)', () => {
    const url = attachmentImageUrl({ kind: 'image', media_type: 'image/jpeg', path: '/srv/claude-uploads/2/x-foto café.jpg' });
    expect(url).toBe('/api/claude/attachments?path=%2Fsrv%2Fclaude-uploads%2F2%2Fx-foto%20caf%C3%A9.jpg&type=image%2Fjpeg');
  });
});

/**
 * "Mapa de agentes" (Agent map) — pedido ao vivo do Bayerl 28/09/2026 ("essa parte de multi agentes
 * igual aqui o claude code do antigravity coloca no claude do orion v2"), retomando o que a rodada
 * anterior (Task/Agent, ver `taskStatusLabel` acima) explicitamente deixou de fora: "telemetria ao
 * vivo (tempo decorrido, tokens, contagem de tool calls do subagente)". Achado confirmado lendo o
 * webview decompilado da extensão real (v2.1.282 e v2.1.283,
 * `/srv/orion-reference/vscode-extension/extension/webview/` e `/srv/orion-reference-2.1.283/webview/`):
 * painel de verdade `title:"Agent map"`, árvore raiz→agentes com linhas de conexão CSS
 * (`.tree`/`.node`/`.children`/`.child`), cada agente com duração (`b85`: prefer `usage.durationMs`
 * quando `status==="finished"`, senão `endTime-startTime`; ao vivo, `Date.now()-startTime`) e tokens
 * (`usage.totalTokens`). O dado de `usage` real (`totalTokens`/`toolUses`/`durationMs`) vem, no SDK
 * real, de `SDKUserMessage.tool_use_result` — campo documentado em
 * `@anthropic-ai/claude-agent-sdk/sdk.d.ts`: "Structured tool output... For the Agent/Task tool the
 * completed shape is the subagent's final report... plus run totals — render from it instead of
 * parsing the tool_result text" — e no schema de `AgentOutput` em `sdk-tools.d.ts`
 * (`{status:"completed", totalTokens, totalToolUseCount, totalDurationMs, usage:{...}}`). O runner do
 * Orion (`server/claude/runner.ts`) já persiste a mensagem SDK INTEIRA (`appendEvent(id, m.type, m)`),
 * então esse campo, quando o SDK o popular, já chega ao front sem nenhuma mudança de backend — mas
 * não pôde ser confirmado ao vivo em produção nesta rodada (sem acesso a credenciais de banco neste
 * ambiente); ver PARIDADE.md pra o relato completo dessa lacuna de verificação.
 */
describe('parseAgentTaskUsage', () => {
  it('undefined: sem dado nenhum', () => {
    expect(parseAgentTaskUsage(undefined)).toBeUndefined();
  });
  it('não é objeto: undefined', () => {
    expect(parseAgentTaskUsage('texto qualquer')).toBeUndefined();
  });
  it('status "async_launched" (subagente em background, ainda sem totais): undefined — nunca inventa um total', () => {
    expect(parseAgentTaskUsage({ status: 'async_launched', agentId: 'a1', outputFile: '/tmp/x' })).toBeUndefined();
  });
  it('status "completed" com os 3 totais reais: extrai totalTokens/toolUses/durationMs', () => {
    const out = parseAgentTaskUsage({ status: 'completed', totalTokens: 311800, totalToolUseCount: 12, totalDurationMs: 1544000 });
    expect(out).toEqual({ totalTokens: 311800, toolUses: 12, durationMs: 1544000 });
  });
  it('status "completed" mas sem nenhum dos 3 campos numéricos: undefined (nada de útil pra mostrar)', () => {
    expect(parseAgentTaskUsage({ status: 'completed', agentId: 'a1' })).toBeUndefined();
  });
  it('status "completed" com só totalTokens: devolve só o que existe, sem inventar os outros', () => {
    expect(parseAgentTaskUsage({ status: 'completed', totalTokens: 500 })).toEqual({ totalTokens: 500, toolUses: undefined, durationMs: undefined });
  });
});

describe('noteAgentTask', () => {
  const taskUse = (id: string, description = 'Investigar o bug', subagent_type?: string): SdkMessage =>
    ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { description, prompt: 'faça x', ...(subagent_type ? { subagent_type } : {}) } }] } } as unknown as SdkMessage);
  const toolResult = (toolUseId: string, isError = false, toolUseResult?: unknown): SdkMessage =>
    ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError }] }, ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}) } as unknown as SdkMessage);

  it('tool_use do Task: cria uma entrada nova, status running, com startedAt = when', () => {
    const out = noteAgentTask({}, taskUse('t1', 'Corrigir o bug do login', 'debugger'), 1000);
    expect(out.t1).toEqual({ toolUseId: 't1', description: 'Corrigir o bug do login', subagentType: 'debugger', status: 'running', startedAt: 1000, endedAt: undefined, usage: undefined });
  });
  it('tool_use de outra ferramenta (não Task): não cria nenhuma entrada, devolve a MESMA referência', () => {
    const bash: SdkMessage = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } } as unknown as SdkMessage;
    const map = {};
    expect(noteAgentTask(map, bash, 1000)).toBe(map);
  });
  it('tool_result de sucesso pro toolUseId certo: fecha a entrada (status success, endedAt)', () => {
    const started = noteAgentTask({}, taskUse('t1'), 1000);
    const out = noteAgentTask(started, toolResult('t1'), 5000);
    expect(out.t1).toMatchObject({ status: 'success', startedAt: 1000, endedAt: 5000 });
  });
  it('tool_result com is_error: fecha como failure', () => {
    const started = noteAgentTask({}, taskUse('t1'), 1000);
    const out = noteAgentTask(started, toolResult('t1', true), 5000);
    expect(out.t1).toMatchObject({ status: 'failure', endedAt: 5000 });
  });
  it('tool_result de um toolUseId desconhecido: não muda nada, devolve a MESMA referência', () => {
    const started = noteAgentTask({}, taskUse('t1'), 1000);
    expect(noteAgentTask(started, toolResult('outro-id'), 5000)).toBe(started);
  });
  it('tool_result com tool_use_result estruturado (AgentOutput completed real): extrai usage real', () => {
    const started = noteAgentTask({}, taskUse('t1'), 1000);
    const out = noteAgentTask(started, toolResult('t1', false, { status: 'completed', totalTokens: 311800, totalToolUseCount: 7, totalDurationMs: 1544000 }), 5000);
    expect(out.t1?.usage).toEqual({ totalTokens: 311800, toolUses: 7, durationMs: 1544000 });
  });
  it('tool_result repetido (replay/reconexão) pro mesmo toolUseId já fechado: não sobrescreve o endedAt real com um "when" mais novo', () => {
    const started = noteAgentTask({}, taskUse('t1'), 1000);
    const closed = noteAgentTask(started, toolResult('t1'), 5000);
    const again = noteAgentTask(closed, toolResult('t1'), 9999);
    expect(again).toBe(closed);
  });
  it('mensagem sem nenhum tool_use/tool_result (ex.: texto puro): devolve a MESMA referência', () => {
    const map = {};
    const text: SdkMessage = { type: 'assistant', message: { content: [{ type: 'text', text: 'oi' }] } } as unknown as SdkMessage;
    expect(noteAgentTask(map, text, 1000)).toBe(map);
  });
});

describe('agentTaskDuration', () => {
  const base: AgentTask = { toolUseId: 't1', description: 'x', status: 'running', startedAt: undefined, endedAt: undefined, usage: undefined };
  it('rodando, com startedAt: tempo decorrido até "now"', () => {
    expect(agentTaskDuration({ ...base, status: 'running', startedAt: 1000 }, 5000)).toBe(4000);
  });
  it('rodando, sem startedAt: undefined (nada pra medir)', () => {
    expect(agentTaskDuration({ ...base, status: 'running' }, 5000)).toBeUndefined();
  });
  it('sucesso, sem usage.durationMs: usa endedAt-startedAt', () => {
    expect(agentTaskDuration({ ...base, status: 'success', startedAt: 1000, endedAt: 5000 }, 9999)).toBe(4000);
  });
  it('sucesso, COM usage.durationMs: prefere o total real reportado pelo SDK (mesma prioridade da extensão real p/ status finished)', () => {
    expect(agentTaskDuration({ ...base, status: 'success', startedAt: 1000, endedAt: 5000, usage: { durationMs: 9999 } }, 99999)).toBe(9999);
  });
  it('falha, COM usage.durationMs e endedAt/startedAt: prefere o computado (mesma prioridade da extensão real p/ status != finished)', () => {
    expect(agentTaskDuration({ ...base, status: 'failure', startedAt: 1000, endedAt: 5000, usage: { durationMs: 9999 } }, 99999)).toBe(4000);
  });
  it('duração menor que 1s: undefined (mesmo limiar da extensão real — não mostra durações irrisórias)', () => {
    expect(agentTaskDuration({ ...base, status: 'success', startedAt: 1000, endedAt: 1500 }, 9999)).toBeUndefined();
  });
  it('sem nenhum dado de tempo: undefined', () => {
    expect(agentTaskDuration({ ...base, status: 'success' }, 9999)).toBeUndefined();
  });
});

describe('formatAgentDuration', () => {
  it('só segundos', () => { expect(formatAgentDuration(5000)).toBe('5s'); });
  it('minutos e segundos', () => { expect(formatAgentDuration(65000)).toBe('1m 5s'); });
  it('exemplo do print do Bayerl: 25m 44s', () => { expect(formatAgentDuration(25 * 60_000 + 44_000)).toBe('25m 44s'); });
  it('arredonda pro segundo mais próximo', () => { expect(formatAgentDuration(1499)).toBe('1s'); });
});

describe('sumSessionTokens', () => {
  it('sem nenhum evento "result": undefined (nunca mostra 0 fabricado)', () => {
    expect(sumSessionTokens([{ id: 'e1', kind: 'text', text: 'oi' }])).toBeUndefined();
  });
  it('um result com tokens: soma entrada+saída', () => {
    const events: ConvEvent[] = [{ id: 'e1', kind: 'result', ok: true, inputTokens: 100, outputTokens: 50 }];
    expect(sumSessionTokens(events)).toBe(150);
  });
  it('vários results (vários turnos): soma tudo', () => {
    const events: ConvEvent[] = [
      { id: 'e1', kind: 'result', ok: true, inputTokens: 100, outputTokens: 50 },
      { id: 'e2', kind: 'result', ok: true, inputTokens: 20, outputTokens: 5 },
    ];
    expect(sumSessionTokens(events)).toBe(175);
  });
  it('result sem outputTokens: trata como 0, não quebra', () => {
    const events: ConvEvent[] = [{ id: 'e1', kind: 'result', ok: true, inputTokens: 30 }];
    expect(sumSessionTokens(events)).toBe(30);
  });
});

describe('agentTaskList', () => {
  it('mapa vazio: lista vazia', () => {
    expect(agentTaskList({})).toEqual([]);
  });
  it('ordena por startedAt crescente (ordem de disparo dos agentes)', () => {
    const map: Record<string, AgentTask> = {
      t2: { toolUseId: 't2', description: 'segundo', status: 'running', startedAt: 2000 },
      t1: { toolUseId: 't1', description: 'primeiro', status: 'running', startedAt: 1000 },
    };
    expect(agentTaskList(map).map(t => t.toolUseId)).toEqual(['t1', 't2']);
  });
  it('entradas sem startedAt vão por último, de forma estável', () => {
    const map: Record<string, AgentTask> = {
      t2: { toolUseId: 't2', description: 'sem tempo', status: 'running' },
      t1: { toolUseId: 't1', description: 'com tempo', status: 'running', startedAt: 1000 },
    };
    expect(agentTaskList(map).map(t => t.toolUseId)).toEqual(['t1', 't2']);
  });
});

/**
 * Validação ao vivo do nome de worktree no compositor — mesma regra de `server/claude/worktree.ts`
 * (duplicada de propósito, ver PARIDADE.md seção 14), extraída da função real `fF0` do webview
 * decompilado v2.1.283. Casos completos (incluindo os limites — 64 vs. 65 caracteres, ".git" com
 * pontos/maiúsculas) já cobertos em `tests/worktree.test.ts` pro lado servidor; aqui confirma que a
 * cópia do lado cliente segue a mesma regra, sem duplicar cada caso.
 */
describe('validateWorktreeName — mesma regra da extensão real, cópia do lado cliente', () => {
  it('aceita nomes normais e rejeita vazio/64+/caracteres fora da lista', () => {
    expect(validateWorktreeName('minha-feature')).toBeNull();
    expect(validateWorktreeName('')).toMatch(/obrigat/);
    expect(validateWorktreeName('a'.repeat(65))).toMatch(/64/);
    expect(validateWorktreeName('tem espaço')).not.toBeNull();
  });
  it('rejeita "." / ".." / terminar em ".lock" / ser ".git"', () => {
    expect(validateWorktreeName('..')).not.toBeNull();
    expect(validateWorktreeName('foo.lock')).not.toBeNull();
    expect(validateWorktreeName('.git')).not.toBeNull();
    expect(validateWorktreeName('.GIT.')).not.toBeNull();
  });
});

/**
 * Nome do worktree de uma sessão a partir do `cwd` (sem coluna nova no Postgres — ver PARIDADE.md
 * seção 14): último segmento do caminho quando `cwd` difere do `path` base do projeto, espelhando a
 * checagem real `worktree.value.path !== defaultCwd.value`. Alimenta o banner em ClaudePage.tsx e a
 * pill na lista de sessões em Sidebar.tsx.
 */
describe('sessionWorktreeName — deriva do cwd, sem coluna nova', () => {
  it('cwd igual ao path do projeto: sessão normal, sem worktree', () => {
    expect(sessionWorktreeName('/srv/orion', '/srv/orion')).toBeNull();
  });
  it('cwd dentro de <path>-worktrees/<nome>: devolve o nome (último segmento)', () => {
    expect(sessionWorktreeName('/srv/orion-worktrees/minha-feature', '/srv/orion')).toBe('minha-feature');
  });
  it('sem cwd ou sem path do projeto: null (nada pra comparar)', () => {
    expect(sessionWorktreeName(null, '/srv/orion')).toBeNull();
    expect(sessionWorktreeName('/srv/orion-worktrees/x', undefined)).toBeNull();
    expect(sessionWorktreeName(undefined, undefined)).toBeNull();
  });
  it('barra final não confunde a comparação', () => {
    expect(sessionWorktreeName('/srv/orion/', '/srv/orion')).toBeNull();
  });
});
