import type { Pool } from 'pg';

/** Tabela chave/valor da Central. Criada aqui (e não em migrations.ts) para não disputar o arquivo com outros agentes. */
export async function ensureSettingsTable(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
}
export async function getSetting(pool: Pool, key: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
export async function setSetting(pool: Pool, key: string, value: string, userId: number | null): Promise<void> {
  await pool.query('INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [key, value, userId]);
}
export async function deleteSetting(pool: Pool, key: string): Promise<void> {
  await pool.query('DELETE FROM settings WHERE key = $1', [key]);
}

export const KEYS = {
  claudeToken: 'claude_oauth_token',
  defaultMode: 'claude_default_mode',
  defaultModel: 'claude_default_model',
  taskBudgetTokens: 'claude_task_budget_tokens',
  hostingerToken: 'hostinger_api_token',
} as const;

/** Token de `claude setup-token`: começa com sk-ant- e é longo. Só validação de forma. */
export function looksLikeClaudeToken(t: string): boolean {
  const s = t.trim();
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(s) && s.length >= 40;
}
export function maskToken(t: string | null): string | null {
  if (!t) return null;
  return `${t.slice(0, 10)}…${t.slice(-4)}`;
}

/** Ambiente para os processos do SDK: herda o do serviço e injeta o token, se houver. */
export function sdkEnv(token: string | null): Record<string, string> | undefined {
  if (!token) return undefined;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export type StdioMcpServerConfig = { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };

/** Um binário do pacote hostinger-api-mcp por vertical da API (mesmo token para todos, igual ao .mcp.json da c1). */
const HOSTINGER_MCP_BINS: Record<string, string> = {
  'hostinger-hosting': 'hostinger-hosting-mcp',
  'hostinger-wordpress': 'hostinger-wordpress-mcp',
  'hostinger-domains': 'hostinger-domains-mcp',
  'hostinger-dns': 'hostinger-dns-mcp',
  'hostinger-billing': 'hostinger-billing-mcp',
  'hostinger-reach': 'hostinger-reach-mcp',
  'hostinger-vps-studio': 'hostinger-vps-mcp',
  'hostinger-ecommerce': 'hostinger-ecommerce-mcp',
};

/** Nomes dos MCPs da Hostinger que entram em toda sessão (para o card de Conectores). */
export const HOSTINGER_MCPS = Object.keys(HOSTINGER_MCP_BINS);

/** Valida o token na API da Hostinger (lista as VPS). null = recusado; senão, quantas VPS a conta tem. */
export async function hostingerVpsCount(token: string): Promise<number | null> {
  try {
    const r = await fetch('https://developers.hostinger.com/api/vps/v1/virtual-machines', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j.length : 0;
  } catch { return null; }
}

/** MCP servers da Hostinger pras sessões do Claude — undefined sem token configurado. */
export function hostingerMcpServers(token: string | null): Record<string, StdioMcpServerConfig> | undefined {
  if (!token) return undefined;
  const out: Record<string, StdioMcpServerConfig> = {};
  for (const [name, bin] of Object.entries(HOSTINGER_MCP_BINS)) {
    out[name] = { type: 'stdio', command: 'npx', args: ['--package=hostinger-api-mcp@latest', bin], env: { APITOKEN: token, HOSTINGER_API_TOKEN: token } };
  }
  return out;
}
