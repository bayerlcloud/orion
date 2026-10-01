import type { Pool } from 'pg';
import { KEYS, getSetting } from '../settings.js';
import { urlDoConector } from './cloudflareAccounts.js';

/** Conectores HTTP genéricos: APIs REST que antes entravam em toda sessão como MCP stdio (npx), ~80-180 MB
 *  por MCP por sessão. Agora a sessão chama /conector/<nome>/<caminho> sem token e o Orion injeta o header.
 *  Hostinger sai do token já salvo (hostinger_api_token); os demais vivem em settings.conectores_http (JSON). */
export const KEY_CONECTORES_HTTP = 'conectores_http';

export type ConectorHttp = {
  nome: string;
  base: string;          // ex.: https://developers.hostinger.com
  header: string;        // ex.: Authorization
  valor: string;         // ex.: Bearer <token> (segredo, nunca vai para o header da sessão)
  dica: string;          // o que a sessão precisa saber para usar (rotas principais)
  bloqueios?: string[];  // "MÉTODO regex" recusados, ex.: "POST ^/?api/vps/v1/virtual-machines/\\d+/recreate"
};

const HOSTINGER: Omit<ConectorHttp, 'valor'> = {
  nome: 'hostinger', base: 'https://developers.hostinger.com', header: 'Authorization',
  dica: 'API da Hostinger (DNS do bayerl.cloud, domínios, VPS). DNS: GET api/dns/v1/zones/<domínio>; '
    + 'PUT api/dns/v1/zones/<domínio> com {"overwrite":false,"zone":[{"name":"x","type":"A","ttl":300,"records":[{"content":"IP"}]}]}; '
    + 'DELETE api/dns/v1/zones/<domínio> com {"filters":[{"name":"x","type":"A"}]}. VPS: GET api/vps/v1/virtual-machines. Domínios: GET api/domains/v1/portfolio. '
    + 'Sempre registro A explícito. Recriar VPS e cancelar assinatura são bloqueados.',
  bloqueios: ['POST ^/?api/vps/v1/virtual-machines/\\d+/recreate', 'DELETE ^/?api/billing/'],
};

export async function listarConectoresHttp(pool: Pool): Promise<ConectorHttp[]> {
  const out: ConectorHttp[] = [];
  const host = await getSetting(pool, KEYS.hostingerToken);
  if (host) out.push({ ...HOSTINGER, valor: `Bearer ${host}` });
  try {
    const extra = JSON.parse((await getSetting(pool, KEY_CONECTORES_HTTP)) ?? '[]');
    if (Array.isArray(extra)) for (const c of extra) if (c?.nome && c?.base && c?.header && c?.valor) out.push(c);
  } catch { /* JSON inválido: ignora os extras */ }
  return out;
}

export function bloqueadoNoHttp(c: ConectorHttp, method: string, caminho: string): boolean {
  return (c.bloqueios ?? []).some(b => {
    const [m, re] = [b.slice(0, b.indexOf(' ')), b.slice(b.indexOf(' ') + 1)];
    return m === method && new RegExp(re, 'i').test(caminho);
  });
}

export type ConectorHttpNoHeader = { nome: string; url: string; dica: string };
export function conectoresHttpParaHeader(cs: ConectorHttp[]): ConectorHttpNoHeader[] {
  return cs.map(c => ({ nome: c.nome, url: urlDoConector(c.nome), dica: c.dica }));
}
