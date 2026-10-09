import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { HttpMcpServerConfig } from './githubAccounts.js';

/** Cofre: o Chrome compartilhado da c3 (container `cofre`, perfil persistente, tela web em browser.bayerl.cloud).
 *  Entra em toda sessão como MCP `cofre` quando COFRE_CDP_URL está no ambiente do serviço. É UM processo
 *  Playwright MCP só (HTTP em loopback, filho do orion-central), compartilhado por todas as sessões: antes
 *  era um stdio por sessão. O Chrome já era um só, então o estado (abas, logins) já era compartilhado. */
export const PLAYWRIGHT_MCP_BIN = process.env.PLAYWRIGHT_MCP_BIN ?? '/srv/tools/playwright/node_modules/.bin/playwright-mcp';

export function cofreCdpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const u = (env.COFRE_CDP_URL ?? '').trim();
  return /^https?:\/\//.test(u) ? u : null;
}
export function cofrePainelUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COFRE_PAINEL_URL ?? '').trim() || 'https://browser.bayerl.cloud';
}

export const COFRE_MCP_PORT = Number(process.env.COFRE_MCP_PORT ?? 8931);
// ponytail: o playwright-mcp só aceita Host localhost:<porta> por padrão; 127.0.0.1 entra no --allowed-hosts.
export const cofreMcpUrl = () => `http://127.0.0.1:${COFRE_MCP_PORT}/mcp`;

export function cofreMcpServers(cdpUrl: string | null): Record<string, HttpMcpServerConfig> | undefined {
  if (!cdpUrl) return undefined;
  return { cofre: { type: 'http', url: cofreMcpUrl(), headers: {} } };
}

export function cofreArgs(cdpUrl: string): string[] {
  return ['--cdp-endpoint', cdpUrl, '--caps', 'vision,pdf', '--image-responses', 'allow', '--port', String(COFRE_MCP_PORT),
    '--host', '127.0.0.1', '--allowed-hosts', `127.0.0.1:${COFRE_MCP_PORT},localhost:${COFRE_MCP_PORT}`,
    '--shared-browser-context', '--output-dir', `${tmpdir()}/cofre-mcp`];
}

/** Sobe o MCP do cofre como filho do serviço e o religa se cair (morre junto com o orion-central). */
export function iniciarCofreCompartilhado(log: (m: string) => void, cdpUrl = cofreCdpUrl()): void {
  if (!cdpUrl) return;
  const subir = () => {
    const p = spawn(PLAYWRIGHT_MCP_BIN, cofreArgs(cdpUrl), { stdio: 'ignore', cwd: tmpdir() });
    p.on('error', e => log(`cofre MCP não subiu: ${e.message}`));
    p.on('exit', code => { log(`cofre MCP saiu (código ${code}); religando em 5 s`); setTimeout(subir, 5000).unref(); });
  };
  subir();
}

export type CofreNoHeader = { painel: string };
export function cofreParaHeader(cdpUrl: string | null, painel: string): CofreNoHeader | null {
  return cdpUrl ? { painel } : null;
}

type AbaCdp = { id: string; type: string; url: string };

/** Fecha abas 'page' vivas há mais que maxIdadeMs, menos uma: a mais antiga do painel do
 *  Orion (home), que fica sempre aberta. Resolve sessão que esquece aba de login/trabalho
 *  aberta no Chrome compartilhado (idade contada desde a primeira vez que o reaper viu a aba,
 *  não desde o último uso real: não dá pra saber "último clique" pelo /json/list do CDP). */
export function abasParaFechar(abas: AbaCdp[], primeiraVezVista: Map<string, number>, agora: number, maxIdadeMs: number): string[] {
  const paginas = abas.filter(a => a.type === 'page').sort((a, b) => (primeiraVezVista.get(a.id) ?? agora) - (primeiraVezVista.get(b.id) ?? agora));
  let homeMantida = false;
  const fechar: string[] = [];
  for (const aba of paginas) {
    const idade = agora - (primeiraVezVista.get(aba.id) ?? agora);
    if (idade <= maxIdadeMs) continue;
    if (!homeMantida && aba.url.startsWith(cofrePainelHomeUrl)) { homeMantida = true; continue; }
    fechar.push(aba.id);
  }
  return fechar;
}

const cofrePainelHomeUrl = 'https://orion.bayerl.cloud/';
export const COFRE_REAPER_MAX_IDADE_MS = Number(process.env.COFRE_REAPER_MAX_IDADE_MIN ?? 20) * 60_000;
const COFRE_REAPER_INTERVALO_MS = 5 * 60_000;

/** Varre as abas do Chrome do cofre a cada 5 min e fecha as esquecidas (login parado, aba de
 *  trabalho de sessão antiga etc). Sem isto, abas se acumulam e travam chamadas de outras
 *  sessões no mesmo browser compartilhado (achado em 2026-10-09). */
export function iniciarReaperAbasCofre(log: (m: string) => void, cdpUrl = cofreCdpUrl(), maxIdadeMs = COFRE_REAPER_MAX_IDADE_MS): void {
  if (!cdpUrl) return;
  const primeiraVezVista = new Map<string, number>();
  const varrer = async () => {
    try {
      const resp = await fetch(`${cdpUrl}/json/list`);
      const abas: AbaCdp[] = await resp.json();
      const agora = Date.now();
      const vivas = new Set(abas.map(a => a.id));
      for (const id of primeiraVezVista.keys()) if (!vivas.has(id)) primeiraVezVista.delete(id);
      for (const aba of abas) if (!primeiraVezVista.has(aba.id)) primeiraVezVista.set(aba.id, agora);
      const fechar = abasParaFechar(abas, primeiraVezVista, agora, maxIdadeMs);
      for (const id of fechar) {
        await fetch(`${cdpUrl}/json/close/${id}`).catch(() => {});
        primeiraVezVista.delete(id);
      }
      if (fechar.length) log(`cofre: fechei ${fechar.length} aba(s) esquecida(s)`);
    } catch (e) {
      log(`cofre: reaper de abas falhou (${(e as Error).message})`);
    }
  };
  setInterval(varrer, COFRE_REAPER_INTERVALO_MS).unref();
  varrer();
}
