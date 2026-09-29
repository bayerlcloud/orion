import type { Pool } from 'pg';

/** Contas GitHub conectadas (aba Tools). Uma linha por conta; cada uma vira um MCP remoto oficial em toda sessão.
 *  Criada aqui (e não em migrations.ts) para não disputar o arquivo com outros agentes. */
export async function ensureGithubAccountsTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS github_accounts (
    id SERIAL PRIMARY KEY, label TEXT NOT NULL UNIQUE, login TEXT NOT NULL, token TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query("ALTER TABLE github_accounts ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''");
}

export type GithubAccount = { id: number; label: string; login: string; email: string; token: string; notes: string };

export async function listarContasGithub(pool: Pool): Promise<GithubAccount[]> {
  const { rows } = await pool.query('SELECT id, label, login, email, token, notes FROM github_accounts ORDER BY id');
  return rows;
}

/** Só forma: PAT clássico (ghp_) ou fine-grained (github_pat_). */
export function looksLikeGithubToken(t: string): boolean {
  return /^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/.test(t.trim());
}

/** Login dono do token, ou null se o GitHub recusar. */
export async function githubLoginDe(token: string): Promise<string | null> {
  try {
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'orion-central' } });
    if (!r.ok) return null;
    return ((await r.json()) as { login?: string }).login ?? null;
  } catch { return null; }
}

/** Nome do MCP server: github-<label em slug>. As tools ficam mcp__github-<slug>__*. */
export function nomeMcpGithub(label: string): string {
  const slug = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `github-${slug || 'conta'}`;
}

export function maskGithubToken(t: string): string {
  return `${t.slice(0, 7)}…${t.slice(-4)}`;
}

export type HttpMcpServerConfig = { type: 'http'; url: string; headers: Record<string, string> };

/** Um MCP remoto oficial do GitHub (github/github-mcp-server hospedado) por conta — {} sem contas. */
export function githubMcpServers(contas: Pick<GithubAccount, 'label' | 'token'>[]): Record<string, HttpMcpServerConfig> {
  const out: Record<string, HttpMcpServerConfig> = {};
  for (const c of contas) out[nomeMcpGithub(c.label)] = { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${c.token}` } };
  return out;
}

export type GithubNoHeader = { nome: string; login: string; email: string; notes: string };
export function githubParaHeader(contas: GithubAccount[]): GithubNoHeader[] {
  return contas.map(c => ({ nome: nomeMcpGithub(c.label), login: c.login, email: c.email, notes: c.notes }));
}
