import { describe, it, expect } from 'vitest';
import { jsonSemNul, slugMcpClaudeAi, disallowConectores, envConectores, envLeve, ENV_LEVE, donoDoRemote, contaGithubDoProjeto, metaLeveza, truncarToolResult, TOOL_RESULT_MAX } from '../server/tools/leveza';

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
  it('põe as 3 variáveis do CLI por cima do env da sessão, sem perder o resto', () => {
    const e = envLeve({ A: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999' });
    expect(e.A).toBe('1');
    expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(ENV_LEVE.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    expect(Number(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW)).toBeLessThanOrEqual(200_000);
    expect(e.BASH_MAX_OUTPUT_LENGTH).toBe('20000');
    expect(e.MAX_MCP_OUTPUT_TOKENS).toBe('10000');
  });
});

describe('jsonSemNul', () => {
  it('tira o \\u0000 do JSON e deixa o resto igual', () => {
    const j = jsonSemNul({ a: 'x\u0000y', b: 'u0000 literal', c: 1 });
    expect(j).toBe('{"a":"xy","b":"u0000 literal","c":1}');
    expect(JSON.parse(j).a).toBe('xy');
  });
});
