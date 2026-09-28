import type { Pool } from 'pg';
import { KEYS, getSetting } from '../settings.js';
import { readClaudeCredentials } from './credentialsFile.js';

/**
 * Busca os limites reais de uso direto na API da Anthropic (mesmo endpoint que o plugin oficial e
 * o Orion antigo usavam: GET /api/oauth/usage), em vez de esperar um campo em algum result do SDK.
 * Exige um token com escopo `user:profile` — o token de `claude setup-token` não tem esse escopo
 * (erro `oauth_scope_insufficient`, confirmado em produção em 2026-09-28); o de `claude auth login`
 * tem. Por isso a ordem de preferência abaixo: primeiro o arquivo de credenciais do login interativo
 * (auto-renovado pelo próprio `claude` CLI a cada uso, igual o Orion antigo lia), só then o token
 * manual salvo nas Configurações (que hoje nunca vai ter esse escopo, mas não custa tentar se um dia
 * o usuário colar um token com escopo mais largo).
 */

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type RawUsageResponse = {
  subscription_type?: string | null;
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_sonnet?: RawWindow;
  seven_day_opus?: RawWindow;
  model_scoped?: { display_name: string; utilization?: number | null; resets_at?: string | null }[];
};

type NormWindow = { utilization: number | null; resets_at: string | null };
type RealRateLimits = {
  five_hour?: NormWindow;
  seven_day?: NormWindow;
  seven_day_sonnet?: NormWindow;
  model_scoped?: (NormWindow & { display_name: string })[];
};
export type RealUsageResult = { subscription_type: string | null; rate_limits: RealRateLimits } | null;

/** A API devolve utilization 0-1; o resto do Orion (computeRealUsageBars) espera 0-100. */
function normWindow(w: RawWindow): NormWindow | null {
  if (!w || w.utilization === null || w.utilization === undefined) return null;
  return { utilization: Math.round(w.utilization * 100), resets_at: w.resets_at ?? null };
}

/** Monta o RealUsageResult a partir da resposta crua da API — função pura, testável sem rede. */
export function parseUsageResponse(data: RawUsageResponse): RealUsageResult {
  const rate_limits: RealRateLimits = {};
  const fh = normWindow(data.five_hour); if (fh) rate_limits.five_hour = fh;
  const sd = normWindow(data.seven_day); if (sd) rate_limits.seven_day = sd;
  const sds = normWindow(data.seven_day_sonnet); if (sds) rate_limits.seven_day_sonnet = sds;
  if (data.model_scoped?.length) {
    rate_limits.model_scoped = data.model_scoped
      .map(m => { const w = normWindow(m); return w ? { display_name: m.display_name, ...w } : null; })
      .filter((x): x is { display_name: string; utilization: number | null; resets_at: string | null } => x !== null);
  }
  if (!Object.keys(rate_limits).length) return null;
  return { subscription_type: data.subscription_type ?? null, rate_limits };
}

let cache: { at: number; value: RealUsageResult } | null = null;
const CACHE_TTL_MS = 60_000;

async function tokenForUsageCall(pool: Pool): Promise<string | null> {
  const fileCreds = await readClaudeCredentials();
  if (fileCreds?.accessToken) return fileCreds.accessToken;
  return getSetting(pool, KEYS.claudeToken);
}

/** Chama a API real; null em qualquer falha (sem escopo, sem token, rede fora) — nunca lança,
 * quem chama já sabe cair para o proxy por custo quando isso devolve null. */
export async function fetchRealUsage(pool: Pool, opts?: { skipCache?: boolean }): Promise<RealUsageResult> {
  if (!opts?.skipCache && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const token = await tokenForUsageCall(pool);
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) { cache = { at: Date.now(), value: null }; return null; }
    const data = (await res.json()) as RawUsageResponse;
    const parsed = parseUsageResponse(data);
    cache = { at: Date.now(), value: parsed };
    return parsed;
  } catch {
    cache = { at: Date.now(), value: null };
    return null;
  }
}
