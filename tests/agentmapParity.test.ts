import { describe, it, expect } from 'vitest';
import {
  reduceSdkMessages, noteAgentTask, applyPendingToAgentTasks, agentsPillDot, agentsPillCount,
  agentsPillCountLabel, agentsPillTitle, splitAgentRows, agentRowLabel, agentRowMeta,
  agentOverflowLabel, agentOverflowMeta, AGENT_ROWS_VISIBLE,
} from '../web/src/claude/mapper';
import type { AgentTask, SdkMessage } from '../web/src/claude/types';

// Trilha par/agentmap (29/09/2026) — ver web/src/claude/PARIDADE-agentmap.md.
// Fixtures no mesmo estilo do bloco noteAgentTask de tests/mapper.test.ts (arquivo separado de
// propósito: várias trilhas de paridade rodam em paralelo e mapper.test.ts é alvo de conflito).

const taskUse = (id: string, description = 'Investigar o bug', subagent_type?: string): SdkMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { description, prompt: 'faça x', ...(subagent_type ? { subagent_type } : {}) } }] } } as unknown as SdkMessage);
const innerUse = (parent: string, id: string, name = 'Bash', input: unknown = { command: 'ls', description: 'Lista arquivos' }): SdkMessage =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } } as unknown as SdkMessage);
const innerResult = (parent: string, toolUseId: string, isError = false): SdkMessage =>
  ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError }] } } as unknown as SdkMessage);

const task = (over: Partial<AgentTask> = {}): AgentTask =>
  ({ toolUseId: 't1', description: 'Investigar o bug', status: 'running', startedAt: 1000, ...over });

describe('reduceSdkMessages — mensagens de subagente (parent_tool_use_id)', () => {
  it('assistant/user com parent_tool_use_id NUNCA entram na timeline principal', () => {
    const messages: SdkMessage[] = [
      taskUse('t1'),
      { type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'texto do subagente' }] } } as unknown as SdkMessage,
      innerUse('t1', 'i1'),
      innerResult('t1', 'i1'),
    ];
    const out = reduceSdkMessages(messages);
    expect(out).toHaveLength(1); // só o tool_use do Task pai
    expect(out[0]).toMatchObject({ kind: 'tool', name: 'Task' });
  });
  it('parent_tool_use_id null (mensagem do agente raiz) segue o caminho de sempre', () => {
    const m = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'oi' }] } } as unknown as SdkMessage;
    expect(reduceSdkMessages([m])).toMatchObject([{ kind: 'text', text: 'oi' }]);
  });
});

describe('noteAgentTask — tool calls aninhadas por subagente', () => {
  it('tool_use com parent conhecido: vira AgentToolCall running, com label/description de describeTool', () => {
    const started = noteAgentTask({}, taskUse('t1'), 1000);
    const out = noteAgentTask(started, innerUse('t1', 'i1'), 2000);
    expect(out.t1.toolCalls).toEqual([{ toolUseId: 'i1', name: 'Bash', label: 'Bash', description: 'Lista arquivos', status: 'running' }]);
  });
  it('tool_result do subagente fecha a call casada (success/failure), sem mexer no task', () => {
    let map = noteAgentTask({}, taskUse('t1'), 1000);
    map = noteAgentTask(map, innerUse('t1', 'i1'), 2000);
    map = noteAgentTask(map, innerUse('t1', 'i2', 'Read', { file_path: '/x' }), 2500);
    map = noteAgentTask(map, innerResult('t1', 'i1'), 3000);
    map = noteAgentTask(map, innerResult('t1', 'i2', true), 3500);
    expect(map.t1.toolCalls?.map(c => c.status)).toEqual(['success', 'failure']);
    expect(map.t1.status).toBe('running'); // o task só fecha no tool_result DELE (sem parent)
  });
  it('parent desconhecido: mesma referência de volta, nunca inventa um task', () => {
    const map = noteAgentTask({}, taskUse('t1'), 1000);
    expect(noteAgentTask(map, innerUse('t-fantasma', 'i1'), 2000)).toBe(map);
    expect(noteAgentTask(map, innerResult('t-fantasma', 'i1'), 2000)).toBe(map);
  });
  it('tool_use repetido (replay/reconexão): não duplica a call', () => {
    let map = noteAgentTask({}, taskUse('t1'), 1000);
    map = noteAgentTask(map, innerUse('t1', 'i1'), 2000);
    const again = noteAgentTask(map, innerUse('t1', 'i1'), 9999);
    expect(again).toBe(map);
  });
  it('tool_result repetido pra call já fechada: mesma referência (não regride o resultado)', () => {
    let map = noteAgentTask({}, taskUse('t1'), 1000);
    map = noteAgentTask(map, innerUse('t1', 'i1'), 2000);
    map = noteAgentTask(map, innerResult('t1', 'i1'), 3000);
    expect(noteAgentTask(map, innerResult('t1', 'i1', true), 9999)).toBe(map);
  });
});

describe('applyPendingToAgentTasks', () => {
  it('sem pendências: mesma referência de volta', () => {
    const tasks = [task()];
    expect(applyPendingToAgentTasks(tasks, [])).toBe(tasks);
  });
  it('permissão pendente numa call aninhada: call E task viram waiting', () => {
    const tasks = [task({ toolCalls: [{ toolUseId: 'i1', name: 'Bash', label: 'Bash', status: 'running' }] })];
    const out = applyPendingToAgentTasks(tasks, ['i1']);
    expect(out[0].toolCalls?.[0].status).toBe('waiting');
    expect(out[0].status).toBe('waiting');
  });
  it('permissão pendente no próprio Task: task vira waiting', () => {
    const out = applyPendingToAgentTasks([task()], ['t1']);
    expect(out[0].status).toBe('waiting');
  });
  it('task já concluído nunca regride, mesmo com id pendente órfão', () => {
    const tasks = [task({ status: 'success', toolCalls: [{ toolUseId: 'i1', name: 'Bash', label: 'Bash', status: 'success' }] })];
    expect(applyPendingToAgentTasks(tasks, ['t1', 'i1'])).toBe(tasks);
  });
});

describe('agents pill (portas de pS/oE1/$P1/CJ5 reais)', () => {
  it('dot: waiting > running > failed > idle', () => {
    expect(agentsPillDot([task({ status: 'waiting' }), task({ status: 'running' })])).toBe('waiting');
    expect(agentsPillDot([task({ status: 'running' }), task({ status: 'failure' })])).toBe('running');
    expect(agentsPillDot([task({ status: 'failure' }), task({ status: 'success' })])).toBe('failed');
    expect(agentsPillDot([task({ status: 'success' })])).toBe('idle');
    expect(agentsPillDot([])).toBe('idle');
  });
  it('contagem: só agentes ativos (running/waiting)', () => {
    expect(agentsPillCount([task({ status: 'running' }), task({ status: 'waiting' }), task({ status: 'success' }), task({ status: 'failure' })])).toBe(2);
  });
  it('rótulo com plural em PT-BR', () => {
    expect(agentsPillCountLabel(1)).toBe('1 agente');
    expect(agentsPillCountLabel(3)).toBe('3 agentes');
  });
  it('título por estado do dot (tabela CJ5 traduzida)', () => {
    expect(agentsPillTitle('waiting')).toContain('aguarda sua permissão');
    expect(agentsPillTitle('running')).toContain('trabalhando');
    expect(agentsPillTitle('failed')).toContain('falhou');
    expect(agentsPillTitle('idle')).toBe('Clique para abrir o Mapa de agentes');
  });
});

describe('linhas dobráveis com overflow (portas de oU0/sU0/$V0/tU0/eU0 reais)', () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => task({ toolUseId: `t${i}` }));
  it('até 4 linhas: todas visíveis, sem overflow (regra HA1+1 real)', () => {
    expect(splitAgentRows(tasks(3))).toEqual({ visible: tasks(3), overflow: [] });
    expect(splitAgentRows(tasks(4))).toEqual({ visible: tasks(4), overflow: [] });
  });
  it('5+: só AGENT_ROWS_VISIBLE visíveis, resto no overflow', () => {
    const { visible, overflow } = splitAgentRows(tasks(6));
    expect(visible).toHaveLength(AGENT_ROWS_VISIBLE);
    expect(overflow).toHaveLength(3);
  });
  it('rótulo da linha: descrição sozinha, ou "descrição: último tool"', () => {
    expect(agentRowLabel(task())).toBe('Investigar o bug');
    expect(agentRowLabel(task({ toolCalls: [{ toolUseId: 'i1', name: 'Bash', label: 'Bash', description: 'Lista arquivos', status: 'running' }] }))).toBe('Investigar o bug: Lista arquivos');
    expect(agentRowLabel(task({ toolCalls: [{ toolUseId: 'i1', name: 'X', label: 'Investigar o bug', status: 'running' }] }))).toBe('Investigar o bug');
  });
  it('meta da linha: decorrido sozinho; com calls, contagem real; com usage, tokens+ferramentas', () => {
    expect(agentRowMeta(task(), 61000)).toBe('1m 0s');
    expect(agentRowMeta(task({ toolCalls: [{ toolUseId: 'i1', name: 'Bash', label: 'Bash', status: 'running' }] }), 5000)).toBe('1 ferramenta · 4s');
    // formatTokens (já existente) arredonda >=10k sem casa decimal: 311800 → "312k"
    expect(agentRowMeta(task({ usage: { totalTokens: 311800, toolUses: 7 } }), 5000)).toBe('312k tokens · 7 ferramentas · 4s');
  });
  it('overflow: rótulo "+N outros agentes" e meta combinada', () => {
    expect(agentOverflowLabel(1)).toBe('+1 outro agente');
    expect(agentOverflowLabel(2)).toBe('+2 outros agentes');
    const two = [task({ startedAt: 1000 }), task({ toolUseId: 't2', startedAt: 2000 })];
    expect(agentOverflowMeta(two, 5000)).toBe('7s combinados');
    const withUsage = [task({ startedAt: 1000, usage: { totalTokens: 1500, toolUses: 2 } }), task({ toolUseId: 't2', startedAt: 2000, usage: { totalTokens: 500, toolUses: 1 } })];
    expect(agentOverflowMeta(withUsage, 5000)).toBe('2.0k tokens · 3 ferramentas · 7s combinados');
  });
});
