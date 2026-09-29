import { describe, expect, it } from 'vitest';
import { githubMcpServers, githubParaHeader, looksLikeGithubToken, nomeMcpGithub } from '../server/tools/githubAccounts.js';
import { buildSystemAppend } from '../server/claude/header.js';

describe('contas GitHub (aba Tools)', () => {
  it('aceita PAT clássico e fine-grained, rejeita o resto', () => {
    expect(looksLikeGithubToken('ghp_' + 'a'.repeat(36))).toBe(true);
    expect(looksLikeGithubToken('github_pat_' + 'A1_'.repeat(20))).toBe(true);
    expect(looksLikeGithubToken('sk-ant-xxx')).toBe(false);
    expect(looksLikeGithubToken('')).toBe(false);
  });
  it('nome do MCP é github-<slug do label>', () => {
    expect(nomeMcpGithub('bayerlcloud')).toBe('github-bayerlcloud');
    expect(nomeMcpGithub('Bayerl Studio Hub!')).toBe('github-bayerl-studio-hub');
    expect(nomeMcpGithub('')).toBe('github-conta');
  });
  it('um MCP remoto oficial por conta, com Bearer; nenhum sem contas', () => {
    expect(githubMcpServers([])).toEqual({});
    const s = githubMcpServers([{ label: 'bayerlcloud', token: 'ghp_x' }, { label: 'hub', token: 'ghp_y' }]);
    expect(Object.keys(s)).toEqual(['github-bayerlcloud', 'github-hub']);
    expect(s['github-bayerlcloud']).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_x' } });
  });
  it('a explicação de cada conta entra no header da sessão', () => {
    const github = githubParaHeader([{ id: 1, label: 'bayerlcloud', login: 'bayerlcloud', email: 'danilo@bayerlstudio.com.br', token: 'ghp_x', notes: 'repos branspace e fisioexpert' }]);
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', github });
    expect(txt).toContain('- github-bayerlcloud (login bayerlcloud, e-mail danilo@bayerlstudio.com.br): repos branspace e fisioexpert');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', github: [] })).not.toContain('Contas GitHub');
  });
});
