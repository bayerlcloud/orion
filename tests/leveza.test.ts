import { describe, it, expect } from 'vitest';
import { enxugarToolUseResult, jsonSemNul, semWorkflowProgress, limiarImagens, semImagensDeFerramenta, slugMcpClaudeAi, disallowConectores, envConectores, envLeve, ENV_LEVE, donoDoRemote, contaGithubDoProjeto, metaLeveza, truncarToolResult, TOOL_RESULT_MAX } from '../server/tools/leveza';

describe('leveza por sessão (12/11/2026)', () => {
  it('slug dos conectores claude.ai igual ao que o CLI usa nas tools', () => {
    expect(slugMcpClaudeAi('claude.ai Magnific (2)')).toBe('claude_ai_Magnific_2');
    expect(slugMcpClaudeAi('claude.ai html.to.design')).toBe('claude_ai_html_to_design');
    expect(slugMcpClaudeAi('claude.ai Google ADS')).toBe('claude_ai_Google_ADS');
  });
  it('disallow: esconde tudo que o projeto não liberou, por servidor inteiro', () => {
    const todos = ['claude.ai Figma', 'claude.ai Canva', 'claude.ai Magnific (2)'];
    expect(disallowConectores(todos, ['claude.ai Figma'])).toEqual(['mcp__claude_ai_Canva', 'mcp__claude_ai_Magnific_2']);
    expect(disallowConectores(todos, todos)).toEqual([]);
  });
  it('env: conectores claude.ai só ligam com pelo menos um liberado; o resto do env fica', () => {
    expect(envConectores({ A: '1' }, [])).toEqual({ A: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(envConectores({ A: '1' }, ['claude.ai Figma']).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('true');
    expect(envConectores(undefined, []).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });
  it('dono do remote: https, ssh, com e sem .git', () => {
    expect(donoDoRemote('https://github.com/bayerlcloud/orion.git')).toBe('bayerlcloud');
    expect(donoDoRemote('git@github.com:BayerlCloud/orion.git')).toBe('bayerlcloud');
    expect(donoDoRemote('https://x@github.com/bayerlhost/site')).toBe('bayerlhost');
    expect(donoDoRemote('https://gitlab.com/a/b')).toBeNull();
    expect(donoDoRemote(null)).toBeNull();
  });
  it('conta do projeto: escolha explícita, nenhuma, ou auto pelo dono do remote', () => {
    const contas = [{ id: 1, login: 'bayerlcloud' }, { id: 2, login: 'bayerlhost' }];
    expect(contaGithubDoProjeto(contas, 2, 'bayerlcloud')?.id).toBe(2);
    expect(contaGithubDoProjeto(contas, 'nenhuma', 'bayerlcloud')).toBeNull();
    expect(contaGithubDoProjeto(contas, 'auto', 'bayerlcloud')?.id).toBe(1);
    expect(contaGithubDoProjeto(contas, undefined, 'BAYERLHOST')?.id).toBe(2);
    expect(contaGithubDoProjeto(contas, undefined, null)).toBeNull();
    expect(contaGithubDoProjeto(contas, 99, 'bayerlcloud')).toBeNull();
  });
  it('metaLeveza não confia na forma do meta', () => {
    expect(metaLeveza(null)).toEqual({ conectores: [], github_conta: undefined, cofre: false });
    expect(metaLeveza({ cofre: true }).cofre).toBe(true);
    expect(metaLeveza({ cofre: 'sim' }).cofre).toBe(false);
    expect(metaLeveza({ conectores: ['claude.ai Figma', 3], github_conta: 'nenhuma' })).toEqual({ conectores: ['claude.ai Figma'], github_conta: 'nenhuma', cofre: false });
    expect(metaLeveza({ github_conta: 'x' }).github_conta).toBeUndefined();
    expect(metaLeveza({ github_conta: 7 }).github_conta).toBe(7);
  });
  it('truncarToolResult corta só tool_result grande e deixa rastro; o resto passa intacto', () => {
    const grande = 'x'.repeat(TOOL_RESULT_MAX + 5000);
    const u = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: grande }, { type: 'text', text: grande }] } };
    const r = truncarToolResult(u) as typeof u;
    expect(r).not.toBe(u);
    expect((r.message.content[0] as any).content.length).toBeLessThan(TOOL_RESULT_MAX + 200);
    expect((r.message.content[0] as any).content).toContain('cortado pelo Orion');
    expect((r.message.content[1] as any).text.length).toBe(grande.length);
    const pequeno = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } };
    expect(truncarToolResult(pequeno)).toBe(pequeno);
    const blocos = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: grande }] }] } };
    expect(((truncarToolResult(blocos) as typeof blocos).message.content[0].content[0] as any).text).toContain('cortado');
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: grande }] } };
    expect(truncarToolResult(assistant)).toBe(assistant);
  });
});

describe('envLeve: contexto por mensagem', () => {
  it('paridade com o plugin (26/11/2026): nenhuma variável do CLI é forçada; o env da sessão passa intacto', () => {
    expect(ENV_LEVE).toEqual({});
    const e = envLeve({ A: '1' });
    expect(e).toEqual({ A: '1' });
    expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});

describe('jsonSemNul', () => {
  it('tira o \\u0000 do JSON e deixa o resto igual', () => {
    const j = jsonSemNul({ a: 'x\u0000y', b: 'u0000 literal', c: 1 });
    expect(j).toBe('{"a":"xy","b":"u0000 literal","c":1}');
    expect(JSON.parse(j).a).toBe('xy');
  });
});

describe('imagens de ferramenta só nos turnos recentes (23/11/2026)', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4096) } };
  it('troca image por nota em tool_result; texto e o resto ficam; sem imagem devolve o mesmo objeto', () => {
    const u = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }, img] }] } };
    const r = semImagensDeFerramenta(u) as typeof u;
    expect(r).not.toBe(u);
    expect((r.message.content[0] as any).content).toEqual([{ type: 'text', text: 'ok' }, { type: 'text', text: '[imagem de ferramenta de um turno antigo (3 KB) não carregada: a sessão viu na hora]' }]);
    const semImg = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'texto' }] } };
    expect(semImagensDeFerramenta(semImg)).toBe(semImg);
    const assistant = { type: 'assistant', message: { content: [img] } };
    expect(semImagensDeFerramenta(assistant)).toBe(assistant);
  });
  it('limiarImagens: seq do 3º prompt mais recente; com menos de 3 prompts, 0 (fica tudo)', () => {
    const ev = [{ type: 'user_prompt', seq: 1 }, { type: 'user', seq: 2 }, { type: 'user_prompt', seq: 10 }, { type: 'user_prompt', seq: 20 }, { type: 'user_prompt', seq: 30 }];
    expect(limiarImagens(ev)).toBe(10);
    expect(limiarImagens(ev.slice(0, 3))).toBe(0);
  });
});

describe('enxugarToolUseResult: só os campos do mapa de agentes', () => {
  it('mantém status/totais do Task e descarta a cópia do resultado; sem o campo devolve o mesmo objeto', () => {
    const u = { type: 'user', message: { content: 'x' }, tool_use_result: { status: 'completed', totalTokens: 10, totalToolUseCount: 2, totalDurationMs: 5, content: [{ type: 'image', source: { data: 'A'.repeat(1000) } }] } };
    expect(enxugarToolUseResult(u)).toEqual({ type: 'user', message: { content: 'x' }, tool_use_result: { status: 'completed', totalTokens: 10, totalToolUseCount: 2, totalDurationMs: 5 } });
    expect(u.tool_use_result.content.length).toBe(1); // nunca muta
    const bash = { type: 'user', message: { content: 'x' }, tool_use_result: { stdout: 'y'.repeat(5000), stderr: '' } };
    expect(enxugarToolUseResult(bash)).toEqual({ type: 'user', message: { content: 'x' } });
    const str = { type: 'user', message: { content: 'x' }, tool_use_result: 'texto cru' };
    expect(enxugarToolUseResult(str)).toEqual({ type: 'user', message: { content: 'x' } });
    const sem = { type: 'user', message: { content: 'x' } };
    expect(enxugarToolUseResult(sem)).toBe(sem);
    const a = { type: 'assistant', tool_use_result: { x: 1 } };
    expect(enxugarToolUseResult(a)).toBe(a);
  });
});

describe('semWorkflowProgress', () => {
  it('tira workflow_progress de system/task_progress e não toca no resto', () => {
    const t = { type: 'system', subtype: 'task_progress', summary: 'x', workflow_progress: new Array(1000).fill({ a: 1 }) };
    expect(semWorkflowProgress(t)).toEqual({ type: 'system', subtype: 'task_progress', summary: 'x' });
    expect(t.workflow_progress.length).toBe(1000);
    const u = { type: 'user', workflow_progress: [1] };
    expect(semWorkflowProgress(u)).toBe(u);
    const s = { type: 'system', subtype: 'init' };
    expect(semWorkflowProgress(s)).toBe(s);
  });
});
