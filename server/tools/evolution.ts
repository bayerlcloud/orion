import type { Pool } from 'pg';
import { getSetting } from '../settings.js';
import { urlDoConector } from './cloudflareAccounts.js';

/** Evolution API (WhatsApp, evo.bayerl.cloud na c1) como CONECTOR SIMPLES: a sessão chama /conector/evolution/<caminho>
 *  sem chave e o Orion injeta o header apikey (a chave global AUTHENTICATION_API_KEY, a mesma EVOLUTION_MASTER_KEY
 *  do Brandspace e do TrackingMachine). URL e chave vivem na tabela settings. */
export const EVOLUTION_KEYS = { url: 'evolution_url', apiKey: 'evolution_api_key', local: 'evolution_local' } as const;
export const NOME_CONECTOR_EVOLUTION = 'evolution';

export async function evolutionConfig(pool: Pool): Promise<{ url: string; apiKey: string } | null> {
  const [url, apiKey] = await Promise.all([getSetting(pool, EVOLUTION_KEYS.url), getSetting(pool, EVOLUTION_KEYS.apiKey)]);
  return url && apiKey ? { url: url.replace(/\/+$/, ''), apiKey } : null;
}

/** ponytail: única trava — apagar instância ou deslogar o WhatsApp de um cliente; o resto (criar, conectar, enviar, webhook) passa. */
export function bloqueadoNaEvolution(method: string, caminho: string): boolean {
  return (method === 'DELETE' && /^\/?instance\/(delete|logout)\//.test(caminho));
}

export type EvolutionNoHeader = { nome: string; url: string; servidor: string };
export function evolutionParaHeader(cfg: { url: string } | null): EvolutionNoHeader | null {
  return cfg ? { nome: NOME_CONECTOR_EVOLUTION, url: urlDoConector(NOME_CONECTOR_EVOLUTION), servidor: cfg.url } : null;
}

/** Card da aba Tools: onde a Evolution roda e as instâncias ao vivo (sem a chave, só a dica). */
export async function evolutionResumo(pool: Pool) {
  const cfg = await evolutionConfig(pool);
  const local = await getSetting(pool, EVOLUTION_KEYS.local);
  if (!cfg) return { conectado: false, servidor: null, local, proxy: urlDoConector(NOME_CONECTOR_EVOLUTION), key_hint: null, versao: null, instancias: [] as { nome: string; status: string }[] };
  const pegar = async (caminho: string) => {
    try { const r = await fetch(`${cfg.url}${caminho}`, { headers: { apikey: cfg.apiKey }, signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const [raiz, lista] = await Promise.all([pegar('/'), pegar('/instance/fetchInstances')]);
  return {
    conectado: Array.isArray(lista), servidor: cfg.url, local, proxy: urlDoConector(NOME_CONECTOR_EVOLUTION),
    key_hint: `${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-3)}`, versao: (raiz as { version?: string } | null)?.version ?? null,
    instancias: Array.isArray(lista) ? lista.map((i: { name: string; connectionStatus: string }) => ({ nome: i.name, status: i.connectionStatus })) : [],
  };
}

/** Conector "whatsapp": o próprio Orion como app do gateway orion-wa (token em settings.whatsapp_token_orion).
 *  A sessão manda alerta por /conector/whatsapp/message/sendText/alertas sem token, e passa pela fila e pelos limites. */
export const NOME_CONECTOR_WHATSAPP = 'whatsapp';
export const WA_TOKEN_ORION = 'whatsapp_token_orion';
export const urlGatewayLocal = () => `http://127.0.0.1:${process.env.WA_PORT ?? 3001}/wa`;
export function whatsappParaHeader(token: string | null): { url: string } | null {
  return token ? { url: urlDoConector(NOME_CONECTOR_WHATSAPP) } : null;
}
