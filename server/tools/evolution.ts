import type { Pool } from 'pg';
import { getSetting } from '../settings.js';
import { urlDoConector } from './cloudflareAccounts.js';

/** Evolution API (WhatsApp, evo.bayerl.cloud na c1) como CONECTOR SIMPLES: a sessão chama /conector/evolution/<caminho>
 *  sem chave e o Orion injeta o header apikey (a chave global AUTHENTICATION_API_KEY, a mesma EVOLUTION_MASTER_KEY
 *  do Brandspace e do TrackingMachine). URL e chave vivem na tabela settings. */
export const EVOLUTION_KEYS = { url: 'evolution_url', apiKey: 'evolution_api_key' } as const;
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
