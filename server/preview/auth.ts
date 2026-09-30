import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Login do Orion no preview pessoal (spec 2026-09-30-preview-design, Parte 1). O cookie do painel
 * fica só no painel (orion.bayerl.cloud e v2.bayerl.cloud, cada um com o seu); para o preview, o painel entrega um token curto e de uso único, preso
 * ao host, e o próprio preview troca esse token por um cookie `orion_preview` daquele host.
 * Formato: base64url(json).base64url(hmac-sha256).
 */

export const COOKIE_PREVIEW = 'orion_preview';
export const LOGIN_URL = 'https://orion.bayerl.cloud/';
export const TOKEN_TTL_MS = 60_000;
export const COOKIE_TTL_MS = 7 * 86_400_000;
/** Preview público liga por 48 h; religar renova. */
export const PUBLICO_TTL_MS = 48 * 3_600_000;
/** Os dois endereços do painel (mesmo Orion, cookie de sessão separado em cada um). */
export const PAINEIS = ['orion.bayerl.cloud', 'v2.bayerl.cloud'];

type Dados = { u: number; h: string; exp: number; j?: string };

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const hmac = (corpo: string, segredo: string) => createHmac('sha256', segredo).update(corpo).digest();

export function assinar(dados: Dados, segredo: string): string {
  const corpo = b64(JSON.stringify(dados));
  return `${corpo}.${b64(hmac(corpo, segredo))}`;
}

/** Devolve `{ u, j? }` se a assinatura confere, o host é o mesmo e não venceu; senão null. */
export function verificar(t: string, host: string, segredo: string, agora = Date.now()): { u: number; j?: string } | null {
  if (!segredo) return null;
  const [corpo, sig] = t.split('.');
  if (!corpo || !sig) return null;
  const esperado = hmac(corpo, segredo);
  const recebido = Buffer.from(sig, 'base64url');
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  let d: Dados;
  try { d = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch { return null; }
  if (d.h !== host || typeof d.u !== 'number' || !(d.exp > agora)) return null;
  return d.j ? { u: d.u, j: d.j } : { u: d.u };
}

// ponytail: Set em memória; reinício do Orion esquece os usados, mas o token vence em 60 s.
const usados = new Map<string, number>();

export function consumirUmaVez(j: string, exp: number): boolean {
  const agora = Date.now();
  for (const [k, e] of usados) if (e <= agora) usados.delete(k);
  if (usados.has(j)) return false;
  usados.set(j, exp);
  return true;
}

export function checarCookie(cookie: string | undefined, host: string, segredo: string, agora = Date.now()): { ok: true; u: number } | { ok: false; redirect: string } {
  const v = cookie ? verificar(cookie, host, segredo, agora) : null;
  return v && !v.j ? { ok: true, u: v.u } : { ok: false, redirect: LOGIN_URL };
}

/** Quem abre um preview: com cookie válido, sempre; sem cookie, só o endereço raiz de projeto com "preview público" ligado. */
export function podeAbrir(o: { ehRaiz: boolean; publico: boolean; cookieOk: boolean }): boolean {
  return o.cookieOk || (o.ehRaiz && o.publico);
}

/** `projects.meta.preview_publico_ate` ainda no futuro? Sem data (ou data ruim) conta como desligado. */
export function publicoAtivo(ate: string | null | undefined, agora = Date.now()): boolean {
  const t = ate ? Date.parse(ate) : NaN;
  return t > agora;
}

/**
 * Sem cookie: manda para o painel, que emite o token daquele host se a pessoa estiver logada lá.
 * Logado só no outro endereço do painel? O `entrar` tenta o próximo da lista antes de pedir senha.
 */
export function urlEntrar(host: string, painel = PAINEIS[0], tentados = ''): string {
  return `https://${painel}/api/preview/entrar?host=${encodeURIComponent(host)}${tentados ? `&tentados=${encodeURIComponent(tentados)}` : ''}`;
}

/** Próximo endereço do painel ainda não tentado, ou null (aí vai para o login). */
export function proximoPainel(atual: string, tentados: string): string | null {
  const ja = new Set([atual, ...tentados.split(',')]);
  return PAINEIS.find(p => !ja.has(p)) ?? null;
}
