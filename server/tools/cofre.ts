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
