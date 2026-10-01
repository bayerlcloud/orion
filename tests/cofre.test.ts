import { describe, expect, it } from 'vitest';
import { cofreArgs, cofreCdpUrl, cofreMcpServers, cofreParaHeader, cofrePainelUrl } from '../server/tools/cofre.js';
import { buildSystemAppend } from '../server/claude/header.js';

describe('Cofre (Chrome compartilhado como MCP)', () => {
  it('só entra quando COFRE_CDP_URL é uma URL http', () => {
    expect(cofreCdpUrl({})).toBeNull();
    expect(cofreCdpUrl({ COFRE_CDP_URL: 'nada' })).toBeNull();
    expect(cofreCdpUrl({ COFRE_CDP_URL: 'http://127.0.0.1:9222' })).toBe('http://127.0.0.1:9222');
    expect(cofrePainelUrl({})).toBe('https://browser.bayerl.cloud');
    expect(cofreMcpServers(null)).toBeUndefined();
  });
  it('toda sessão aponta para o MCP único em HTTP local (um processo só, não um por sessão)', () => {
    const s = cofreMcpServers('http://127.0.0.1:9222')!;
    expect(Object.keys(s)).toEqual(['cofre']);
    expect(s.cofre).toEqual({ type: 'http', url: 'http://127.0.0.1:8931/mcp', headers: {} });
  });
  it('o processo único é o Playwright MCP no CDP, com vision e pdf, aceitando Host 127.0.0.1', () => {
    const a = cofreArgs('http://127.0.0.1:9222');
    expect(a.slice(0, 6)).toEqual(['--cdp-endpoint', 'http://127.0.0.1:9222', '--caps', 'vision,pdf', '--image-responses', 'allow']);
    expect(a).toContain('--shared-browser-context');
    expect(a[a.indexOf('--allowed-hosts') + 1]).toContain('127.0.0.1:8931');
  });
  it('o header explica o Cofre e o painel para login manual', () => {
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cofre: cofreParaHeader('http://127.0.0.1:9222', 'https://browser.bayerl.cloud') });
    expect(txt).toContain('mcp__cofre__');
    expect(txt).toContain('https://browser.bayerl.cloud');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cofre: null })).not.toContain('Cofre');
  });
});
