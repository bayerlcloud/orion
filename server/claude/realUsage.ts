import type { Pool } from 'pg';
import { KEYS, getSetting } from '../settings.js';
import { getValidAccessToken } from './credentialsFile.js';

/**
 * Busca os limites reais de uso direto na API da Anthropic (mesmo endpoint que o plugin oficial usa:
 * GET /api/oauth/usage), em vez de esperar um campo em algum result do SDK. Exige um token com
 * escopo `user:profile` — o token de `claude setup-token` não tem esse escopo (erro
 * `oauth_scope_insufficient`, confirmado em produção em 2026-09-28); o de `claude auth login` tem.
 * Ordem de preferência: primeiro o arquivo de credenciais do login interativo (auto-renovado pelo
 * próprio `claude` CLI a cada uso), só então o token manual salvo nas Configurações.
 *
 * Formato real da resposta (capturado ao vivo em produção em 2026-09-28, primeiro login bem
 * sucedido — **diferente** do que a nota antiga desta função e o `usage.js` do Orion antigo
 * assumiam, API deve ter mudado desde então):
 * - `five_hour.utilization` e `seven_day.utilization` já vêm em **escala 0-100** (ex.: `12.0` =
 *   12%), não 0-1 — multiplicar por 100 de novo (o bug do primeiro deploy) estoura pra 100% em
 *   qualquer conta com uso > 1%.
 * - Não existe `model_scoped[]` nem `subscription_type` na resposta. O limite específico de modelo
 *   (rótulo "Fable" na captura de tela do Bayerl) vem dentro do array `limits[]`, num item com
 *   `kind: "weekly_scoped"` e `scope.model.display_name`. Os outros dois `kind` úteis nesse array são
 *   `"session"` (mesmo dado de `five_hour`) e `"weekly_all"` (mesmo dado de `seven_day`) — usamos os
 *   campos de topo pra esses dois por serem mais diretos, e só o `limits[]` pro terceiro, que não
 *   existe em nenhum outro lugar da resposta.
 */

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type RawLimit = {
  kind?: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
};
type RawUsageResponse = {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  limits?: RawLimit[];
};

type NormWindow = { utilization: number | null; resets_at: string | null };
type RealRateLimits = {
  five_hour?: NormWindow;
  seven_day?: NormWindow;
  model_scoped?: (NormWindow & { display_name: string })[];
};
export type RealUsageResult = { subscription_type: string | null; rate_limits: RealRateLimits } | null;

function clampPct(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** utilization já vem em 0-100 (ver nota acima) — só arredonda e limita, nunca multiplica. */
function normWindow(w: RawWindow): NormWindow | null {
  if (!w || w.utilization === null || w.utilization === undefined) return null;
  return { utilization: clampPct(w.utilization), resets_at: w.resets_at ?? null };
}

/** Acha o limite semanal específico de modelo (kind "weekly_scoped", rótulo em scope.model.display_name)
 * — é o único lugar da resposta onde esse dado (ex.: "Fable") existe. */
function modelScopedFromLimits(limits: RawLimit[] | undefined): (NormWindow & { display_name: string })[] {
  if (!limits?.length) return [];
  return limits
    .filter(l => l.kind === 'weekly_scoped' && l.scope?.model?.display_name && l.percent !== null && l.percent !== undefined)
    .map(l => ({ display_name: l.scope!.model!.display_name!, utilization: clampPct(l.percent!), resets_at: l.resets_at ?? null }));
}

/** Monta o RealUsageResult a partir da resposta crua da API — função pura, testável sem rede.
 * `subscription_type` não existe nessa resposta (ver nota acima); sempre null. */
export function parseUsageResponse(data: RawUsageResponse): RealUsageResult {
  const rate_limits: RealRateLimits = {};
  const fh = normWindow(data.five_hour); if (fh) rate_limits.five_hour = fh;
  const sd = normWindow(data.seven_day); if (sd) rate_limits.seven_day = sd;
  const modelScoped = modelScopedFromLimits(data.limits);
  if (modelScoped.length) rate_limits.model_scoped = modelScoped;
  if (!Object.keys(rate_limits).length) return null;
  return { subscription_type: null, rate_limits };
}

let cache: { at: number; value: RealUsageResult } | null = null;
const CACHE_TTL_MS = 60_000;

async function tokenForUsageCall(pool: Pool): Promise<string | null> {
  // getValidAccessToken() já renova sozinho um token expirado (e persiste de volta no arquivo do
  // CLI) — ver credentialsFile.ts pro porquê disso ser necessário (token parado sem renovar por
  // falta de sessão ativa do `claude` CLI era a causa da tela de uso "descalibrar", 29/09/2026).
  const fileToken = await getValidAccessToken();
  if (fileToken) return fileToken;
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
