import { describe, expect, it } from 'vitest';
import { githubMcpServers, looksLikeGithubToken } from '../server/settings.js';

describe('conector GitHub', () => {
  it('aceita PAT clássico e fine-grained, rejeita o resto', () => {
    expect(looksLikeGithubToken('ghp_' + 'a'.repeat(36))).toBe(true);
    expect(looksLikeGithubToken('github_pat_' + 'A1_'.repeat(20))).toBe(true);
    expect(looksLikeGithubToken('sk-ant-xxx')).toBe(false);
    expect(looksLikeGithubToken('')).toBe(false);
  });
  it('sem token não entra MCP; com token entra o remoto oficial com Bearer', () => {
    expect(githubMcpServers(null)).toBeUndefined();
    const s = githubMcpServers('ghp_x')!;
    expect(s.github.type).toBe('http');
    expect(s.github.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(s.github.headers.Authorization).toBe('Bearer ghp_x');
  });
});
