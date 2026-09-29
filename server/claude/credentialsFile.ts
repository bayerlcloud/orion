import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Onde o `claude` CLI guarda a sessão de login interativo (`claude auth login`), diferente do
 * token estático de `claude setup-token` (esse fica só no Postgres, via server/settings.ts). */
export function credentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export type ClaudeCredentials = { accessToken: string; refreshToken?: string; expiresAt?: number; scopes?: string[] };

/** Lê e valida a estrutura `claudeAiOauth` do arquivo de credenciais do CLI. null se ausente/inválido —
 * nunca lança, quem chama decide o que fazer na ausência (ex.: cair para o token manual). */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf8');
    const d = JSON.parse(raw);
    const oauth = d?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Escreve `accessToken`/`refreshToken`/`expiresAt` novos de volta no arquivo de credenciais do CLI,
 * preservando TODAS as outras chaves (`mcpOAuth`, `subscriptionType`, `rateLimitTier`, `scopes`...) —
 * essencial (não cosmético): o endpoint de refresh normalmente REEMITE um `refreshToken` novo
 * (rotação), e o `refreshToken` antigo pode já não servir mais depois — se o Orion não persistisse
 * de volta, o próprio `claude` CLI (ou o Orion na próxima chamada) tentaria renovar de novo com um
 * refreshToken já invalidado, quebrando o login de vez (exigiria `claude auth login` de novo). Sem
 * arquivo/`claudeAiOauth` ainda (não deveria acontecer — só chega aqui depois de já ter lido um
 * `refreshToken` de algum lugar — mas por segurança nunca lança, só devolve sem fazer nada). Escrita
 * atômica (arquivo temp + rename), mesmo padrão de `server/claude/permissionRules.ts`.
 */
async function persistRefreshedTokens(tokens: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void> {
  const filePath = credentialsPath();
  let raw: any;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return;
  }
  if (!raw?.claudeAiOauth) return;
  raw.claudeAiOauth = { ...raw.claudeAiOauth, ...tokens };
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

/**
 * Expirado ou perto disso (`bufferMs`, default 60s — a mesma janela do cache de `fetchRealUsage` em
 * `realUsage.ts`, pra nunca usar um token que pode morrer no meio da própria chamada de uso).
 * `expiresAt` ausente: trata como expirado — mais seguro forçar uma renovação (ou falhar
 * silenciosamente, se não houver `refreshToken`) do que arriscar usar um token sem saber a validade.
 */
export function isTokenExpired(expiresAt: number | undefined, now: number, bufferMs = 60_000): boolean {
  if (expiresAt === undefined) return true;
  return expiresAt - bufferMs <= now;
}

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Mesmo client_id que a extensão real usa pro fluxo `claude.ai` (confirmado lendo `extension.js`
 * v2.1.283 — `AI_ORIGIN:"https://claude.ai"` pareado com este client_id e este `TOKEN_URL`, função
 * `doRefreshOAuthToken`). É o mesmo fluxo que `claude auth login --claudeai` usa (ver `login.ts`),
 * então o client_id tem que bater com o client_id que emitiu o token original. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; statusText?: string; json: () => Promise<any> }>;

/**
 * Chama o endpoint real de refresh OAuth (mesma URL/client_id/formato de corpo que a extensão real
 * usa — `doRefreshOAuthToken` em `extension.js`). `fetchImpl`/`now` injetáveis (mesmo padrão de I/O
 * injetável do projeto) — testável sem rede de verdade. `null` em QUALQUER falha (sem refreshToken,
 * resposta não-200, rede fora, corpo inesperado) — nunca lança; quem chama decide o que fazer (cair
 * pro proxy por custo, no caso de `realUsage.ts`).
 */
export async function refreshAccessToken(
  creds: { refreshToken?: string; scopes?: string[] },
  opts: { fetchImpl?: FetchLike; now?: () => number } = {},
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number } | null> {
  if (!creds.refreshToken) return null;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID,
        scope: (creds.scopes ?? []).join(' '),
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.access_token !== 'string' || typeof data?.expires_in !== 'number') return null;
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : creds.refreshToken,
      expiresAt: now() + data.expires_in * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Um `accessToken` pronto pra usar: lê o arquivo de credenciais do CLI, renova se estiver
 * expirado/perto disso (persistindo o token novo de volta no arquivo — ver `persistRefreshedTokens`)
 * e devolve. `null` sem arquivo, sem `refreshToken` quando precisa renovar, ou se a renovação falhar
 * (ex.: `refreshToken` também já expirou — só um `claude auth login` novo resolve nesse caso).
 *
 * Antes desta função, `realUsage.ts` usava `accessToken` direto do arquivo sem checar `expiresAt` —
 * um token expirado (o `claude` CLI só renova quando ELE MESMO é usado; sem nenhuma sessão ativa por
 * um tempo, o arquivo fica com um token morto) fazia toda chamada a `/api/oauth/usage` falhar com
 * 401, e a tela caía pro proxy por custo — que reusa os MESMOS rótulos dos dados reais
 * ("Sessão (5h)", "Semanal (7 dias)", "Limite Fable") mas mostra um cálculo completamente diferente
 * (gasto em dólar dividido por um teto arbitrário), sem nenhuma indicação visual de que não é o dado
 * real — daí a tela parecer "descalibrada" (achado ao vivo, 29/09/2026, ver PARIDADE.md).
 */
export async function getValidAccessToken(opts: { fetchImpl?: FetchLike; now?: () => number } = {}): Promise<string | null> {
  const creds = await readClaudeCredentials();
  if (!creds) return null;
  const now = (opts.now ?? Date.now)();
  if (!isTokenExpired(creds.expiresAt, now)) return creds.accessToken;
  const refreshed = await refreshAccessToken(creds, opts);
  if (!refreshed) return null;
  await persistRefreshedTokens(refreshed);
  return refreshed.accessToken;
}
