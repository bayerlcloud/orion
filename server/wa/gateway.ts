import { createHash, createHmac } from 'node:crypto';

/** Lógica pura do gateway de WhatsApp (spec docs/superpowers/specs/2026-10-01-gateway-whatsapp.md). */

export type Modo = 'ouvir' | 'conversar';
export type Rota =
  | { tipo: 'enviar'; apelido: string; evo: string }
  | { tipo: 'estado'; apelido: string }
  | { tipo: 'instancias' }
  | { tipo: 'leitura'; apelido: string; evo: string };

/** O que o /wa aceita. Tudo que não estiver aqui é 403 (criar, apagar, conectar, webhook, settings...). */
export function rotaPermitida(method: string, caminho: string): Rota | null {
  const c = caminho.replace(/^\/+/, '').split('?')[0];
  let m = /^message\/(sendText|sendMedia)\/([^/]+)$/.exec(c);
  if (m && method === 'POST') return { tipo: 'enviar', apelido: decodeURIComponent(m[2]), evo: `message/${m[1]}` };
  m = /^instance\/connectionState\/([^/]+)$/.exec(c);
  if (m && method === 'GET') return { tipo: 'estado', apelido: decodeURIComponent(m[1]) };
  if (c === 'instance/fetchInstances' && method === 'GET') return { tipo: 'instancias' };
  m = /^(group\/fetchAllGroups|chat\/findContacts)\/([^/]+)$/.exec(c);
  if (m && (method === 'GET' || method === 'POST')) return { tipo: 'leitura', apelido: decodeURIComponent(m[2]), evo: m[1] };
  return null;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const assinatura = (segredo: string, corpo: string) => `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;

/** Contato canônico: jid inteiro para grupo, só dígitos para pessoa (no endereçamento @lid, o número vem no Alt). */
export function contatoDe(jid: string, alt?: string | null): string {
  if (/@g\.us$/.test(jid)) return jid;
  const base = /@lid$/.test(jid) && alt ? alt : jid;
  return base.replace(/@.*/, '').replace(/\D/g, '');
}

/** Contato do destino de um envio (campo number da Evolution: número, jid de pessoa ou jid de grupo). */
export const contatoDoDestino = (number: unknown) => contatoDe(String(number ?? ''));

export const apelidoDoModo = (modo: Modo) => (modo === 'conversar' ? 'conversa' : 'alertas');

/** Payload da Evolution como o app recebe: sem a apikey da instância, server_url e instance trocados. */
export function limparPayload(payload: any, apelido: string, servidor: string): any {
  const { apikey: _fora, ...resto } = payload ?? {};
  return { ...resto, instance: apelido, server_url: servidor };
}

/** Espera do reenvio: 10 s, 30 s, 1,5 min... até 1 h; desiste depois de 10 tentativas. */
export const MAX_TENTATIVAS = 10;
export const esperaReenvio = (tentativa: number) => Math.min(3600, 10 * 3 ** (tentativa - 1)) * 1000;

/** Intervalo entre envios do mesmo número: 3 a 8 s aleatórios. */
export const intervaloEnvio = (rand = Math.random) => 3000 + Math.floor(rand() * 5000);
