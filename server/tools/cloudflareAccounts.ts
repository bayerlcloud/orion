import type { Pool } from 'pg';

/** Contas Cloudflare conectadas (aba Tools). Uma linha por conta; cada uma vira o MCP remoto oficial da
 *  Cloudflare (bindings: Workers, KV, R2, D1, Hyperdrive) em toda sessão. Mesmo desenho de githubAccounts.ts. */
export async function ensureCloudflareAccountsTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS cloudflare_accounts (
    id SERIAL PRIMARY KEY, label TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, account_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '', token TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

export type CloudflareAccount = { id: number; label: string; account_id: string; account_name: string; email: string; token: string; notes: string };

export async function listarContasCloudflare(pool: Pool): Promise<CloudflareAccount[]> {
  const { rows } = await pool.query('SELECT id, label, account_id, account_name, email, token, notes FROM cloudflare_accounts ORDER BY id');
  return rows;
}

/** Só forma: token de conta (cfat_), de usuário (cfut_) ou o formato antigo de 40 caracteres. */
export function looksLikeCloudflareToken(t: string): boolean {
  return /^(cf[au]t_[A-Za-z0-9]{30,}|[A-Za-z0-9_-]{40})$/.test(t.trim());
}
export function looksLikeCloudflareAccountId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id.trim());
}

/** Nome da conta se o token consegue ler essa conta (GET /accounts/:id), ou null se a Cloudflare recusar. */
export async function cloudflareContaDe(accountId: string, token: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as { success?: boolean; result?: { name?: string } };
    return j.success ? (j.result?.name ?? '') : null;
  } catch { return null; }
}

/** Nome do MCP server: cloudflare-<label em slug>. As tools ficam mcp__cloudflare-<slug>__*. */
export function nomeMcpCloudflare(label: string): string {
  const slug = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `cloudflare-${slug || 'conta'}`;
}

export function maskCloudflareToken(t: string): string {
  return `${t.slice(0, 5)}…${t.slice(-4)}`;
}

export type HttpMcpServerConfig = { type: 'http'; url: string; headers: Record<string, string> };

/** Um MCP remoto oficial da Cloudflare (bindings) por conta, com o token da conta como Bearer — {} sem contas. */
export function cloudflareMcpServers(contas: Pick<CloudflareAccount, 'label' | 'token'>[]): Record<string, HttpMcpServerConfig> {
  const out: Record<string, HttpMcpServerConfig> = {};
  for (const c of contas) out[nomeMcpCloudflare(c.label)] = { type: 'http', url: 'https://bindings.mcp.cloudflare.com/mcp', headers: { Authorization: `Bearer ${c.token}` } };
  return out;
}

export type CloudflareNoHeader = { nome: string; account_id: string; account_name: string; email: string; notes: string };
export function cloudflareParaHeader(contas: CloudflareAccount[]): CloudflareNoHeader[] {
  return contas.map(c => ({ nome: nomeMcpCloudflare(c.label), account_id: c.account_id, account_name: c.account_name, email: c.email, notes: c.notes }));
}
