import type { StdioMcpServerConfig } from '../settings.js';

/** Cofre: o Chrome compartilhado da c3 (container `cofre`, perfil persistente, tela web em browser.bayerl.cloud).
 *  Entra em toda sessão como MCP `cofre` (Playwright MCP oficial apontado para o CDP do container) quando
 *  COFRE_CDP_URL está no ambiente do serviço. Não é MCP remoto: o binário está em /srv/tools/playwright. */
export const PLAYWRIGHT_MCP_BIN = process.env.PLAYWRIGHT_MCP_BIN ?? '/srv/tools/playwright/node_modules/.bin/playwright-mcp';

export function cofreCdpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const u = (env.COFRE_CDP_URL ?? '').trim();
  return /^https?:\/\//.test(u) ? u : null;
}
export function cofrePainelUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COFRE_PAINEL_URL ?? '').trim() || 'https://browser.bayerl.cloud';
}

export function cofreMcpServers(cdpUrl: string | null): Record<string, StdioMcpServerConfig> | undefined {
  if (!cdpUrl) return undefined;
  return { cofre: { type: 'stdio', command: PLAYWRIGHT_MCP_BIN, args: ['--cdp-endpoint', cdpUrl, '--caps', 'vision,pdf', '--image-responses', 'allow'], env: {} } };
}

export type CofreNoHeader = { painel: string };
export function cofreParaHeader(cdpUrl: string | null, painel: string): CofreNoHeader | null {
  return cdpUrl ? { painel } : null;
}
