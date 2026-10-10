import type { Pool } from 'pg';
import { createSign } from 'node:crypto';

/** Contas Google Cloud conectadas (aba Tools). Uma linha por conta (service account); cada uma vira um
 *  CONECTOR SIMPLES: a sessão chama qualquer API do Google (compute, storage, run...) pelo proxy local
 *  /conector/<nome> (routes/conector.ts) sem credencial; o Orion assina o JWT, troca por access token e
 *  injeta o Bearer. Tabela e rotas seguem o desenho de cloudflareAccounts.ts. */
export async function ensureGoogleCloudAccountsTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS google_cloud_accounts (
    id SERIAL PRIMARY KEY, label TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL DEFAULT '', client_email TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '', sa_json TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

export type GoogleCloudAccount = { id: number; label: string; project_id: string; client_email: string; email: string; sa_json: string; notes: string };
type ServiceAccount = { type?: string; project_id?: string; client_email?: string; private_key?: string };

export async function listarContasGoogleCloud(pool: Pool): Promise<GoogleCloudAccount[]> {
  const { rows } = await pool.query('SELECT id, label, project_id, client_email, email, sa_json, notes FROM google_cloud_accounts ORDER BY id');
  return rows;
}

/** Chave de service account do Google: JSON com type service_account, client_email e private_key. Devolve a
 *  credencial já parseada, ou null se o texto não for isso. */
export function parseServiceAccountJson(texto: string): ServiceAccount | null {
  try {
    const j = JSON.parse(texto) as ServiceAccount;
    return j.type === 'service_account' && j.client_email && j.private_key ? j : null;
  } catch { return null; }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Assina um JWT (RS256) de autorização de service account e troca por access token no Google.
 *  Escopo cloud-platform cobre todas as APIs; quem limita é o papel (role) da conta no IAM do Google. */
async function trocarPorAccessToken(sa: ServiceAccount): Promise<{ token: string; exp: number } | null> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const assinante = createSign('RSA-SHA256');
  assinante.update(`${header}.${claim}`);
  assinante.end();
  let assinatura: Buffer;
  try { assinatura = assinante.sign(sa.private_key!); } catch { return null; }
  const jwt = `${header}.${claim}.${base64url(assinatura)}`;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    return { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  } catch { return null; }
}

/** Cache em memória do processo: um access token por conta (client_email), renovado 5 min antes de expirar.
 *  ponytail: cache simples em Map global, chave é o e-mail da service account (único por conta). */
const cacheToken = new Map<string, { token: string; exp: number }>();
export async function googleAccessTokenDe(conta: Pick<GoogleCloudAccount, 'client_email' | 'sa_json'>): Promise<string | null> {
  const atual = cacheToken.get(conta.client_email);
  if (atual && atual.exp - 300 > Math.floor(Date.now() / 1000)) return atual.token;
  const sa = parseServiceAccountJson(conta.sa_json);
  if (!sa) return null;
  const novo = await trocarPorAccessToken(sa);
  if (!novo) return null;
  cacheToken.set(conta.client_email, novo);
  return novo.token;
}

/** Testa a credencial trocando por um access token de verdade; devolve os dados públicos ou null se o Google recusar. */
export async function googleCloudContaDe(saJson: string): Promise<{ project_id: string; client_email: string } | null> {
  const sa = parseServiceAccountJson(saJson);
  if (!sa) return null;
  const token = await trocarPorAccessToken(sa);
  if (!token) return null;
  return { project_id: sa.project_id ?? '', client_email: sa.client_email! };
}

/** Nome do conector: gcp-<label em slug>. O proxy fica em /conector/gcp-<slug>/<host da API>/<caminho>. */
export function nomeConectorGoogleCloud(label: string): string {
  const slug = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `gcp-${slug || 'conta'}`;
}

export function maskServiceAccountJson(saJson: string): string {
  const sa = parseServiceAccountJson(saJson);
  return sa?.client_email ?? '';
}

export const CONECTOR_BASE_GCP = `http://127.0.0.1:${process.env.PORT ?? 3000}/conector`;
export function urlDoConectorGcp(nome: string): string {
  return `${CONECTOR_BASE_GCP}/${nome}`;
}
export function contaDoConectorGcp(nome: string, contas: GoogleCloudAccount[]): GoogleCloudAccount | null {
  return contas.find(c => nomeConectorGoogleCloud(c.label) === nome) ?? null;
}

/** ponytail: única trava do proxy, no desenho do bloqueio da Cloudflare — não apaga projeto nem organização inteira. */
export function bloqueadoNoConectorGcp(method: string, caminho: string): boolean {
  if (method !== 'DELETE') return false;
  return /^cloudresourcemanager\.googleapis\.com\/v(1|3)\/(projects|organizations)\/[^/]+\/?$/.test(caminho);
}

export type GoogleCloudNoHeader = { nome: string; url: string; project_id: string; client_email: string; email: string; notes: string };
export function googleCloudParaHeader(contas: GoogleCloudAccount[]): GoogleCloudNoHeader[] {
  return contas.map(c => { const nome = nomeConectorGoogleCloud(c.label); return { nome, url: urlDoConectorGcp(nome), project_id: c.project_id, client_email: c.client_email, email: c.email, notes: c.notes }; });
}
