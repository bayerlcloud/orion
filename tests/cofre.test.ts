import { describe, expect, it } from 'vitest';
import { abasParaFechar, cofreArgs, cofreCdpUrl, cofreMcpServers, cofreParaHeader, cofrePainelUrl, dirCofre } from '../server/tools/cofre.js';
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
  it('a pasta de saída fica fora de /tmp (PrivateTmp: o claude do runner não vê o /tmp do painel) e aceita ORION_COFRE_DIR', () => {
    expect(dirCofre({})).toBe('/srv/claude-uploads/cofre-mcp');
    expect(dirCofre({ ORION_COFRE_DIR: '/srv/x ' })).toBe('/srv/x');
    const a = cofreArgs('http://127.0.0.1:9222', dirCofre({}));
    expect(a[a.indexOf('--output-dir') + 1]).toBe('/srv/claude-uploads/cofre-mcp');
    expect(cofreArgs('http://127.0.0.1:9222').some(x => x.startsWith('/tmp'))).toBe(false);
  });
  it('o header explica o Cofre e o painel para login manual', () => {
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cofre: cofreParaHeader('http://127.0.0.1:9222', 'https://browser.bayerl.cloud') });
    expect(txt).toContain('mcp__cofre__');
    expect(txt).toContain('https://browser.bayerl.cloud');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cofre: null })).not.toContain('Cofre');
  });
  it('reaper: fecha abas antigas, mas mantém sempre uma aba do Orion aberta (home)', () => {
    const agora = 1_000_000;
    const vistas = new Map([
      ['home', agora - 60 * 60_000],
      ['login-travado', agora - 30 * 60_000],
      ['recente', agora - 2 * 60_000],
    ]);
    const abas = [
      { id: 'home', type: 'page', url: 'https://orion.bayerl.cloud/' },
      { id: 'login-travado', type: 'page', url: 'https://accounts.google.com/signin' },
      { id: 'recente', type: 'page', url: 'https://outrosite.com/' },
      { id: 'popup', type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/' },
    ];
    expect(abasParaFechar(abas, vistas, agora, 20 * 60_000)).toEqual(['login-travado']);
  });
  it('reaper: sem aba do Orion viva, fecha a mais antiga que for "page" excedida também', () => {
    const agora = 1_000_000;
    const vistas = new Map([
      ['velha1', agora - 40 * 60_000],
      ['velha2', agora - 30 * 60_000],
    ]);
    const abas = [
      { id: 'velha1', type: 'page', url: 'https://accounts.google.com/signin' },
      { id: 'velha2', type: 'page', url: 'https://outrosite.com/' },
    ];
    expect(abasParaFechar(abas, vistas, agora, 20 * 60_000)).toEqual(['velha1', 'velha2']);
  });
});
