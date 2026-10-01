import type { Pool } from 'pg';

/** Canal WhatsApp do Orion (fase 1 do gateway): uma instância da Evolution vinculada em Configurações,
 *  webhook dela apontando para /api/whatsapp/webhook/<segredo>, e tudo que entra ou sai gravado em wa_mensagens. */
export const WA_KEYS = { instancia: 'whatsapp_instancia', segredo: 'whatsapp_webhook_segredo' } as const;
export const WA_EVENTOS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];

export async function ensureWhatsappTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_mensagens (
    id BIGSERIAL PRIMARY KEY, instancia TEXT NOT NULL, direcao TEXT NOT NULL, remoto TEXT NOT NULL, nome TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL DEFAULT '', msg_id TEXT UNIQUE, enviado_por INT,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(), payload JSONB)`);
}

export type MensagemWa = { instancia: string; direcao: 'entra' | 'sai'; remoto: string; nome: string; tipo: string; texto: string; msg_id: string | null; ts: Date };

/** Lê um evento messages.upsert da Evolution v2. Outros eventos (ou mensagem sem chave) devolvem null. */
export function lerEventoMensagem(ev: any): MensagemWa | null {
  if (String(ev?.event ?? '').toLowerCase().replace('_', '.') !== 'messages.upsert') return null;
  const d = Array.isArray(ev.data) ? ev.data[0] : ev.data;
  const key = d?.key;
  if (!key?.remoteJid) return null;
  const m = d.message ?? {};
  const texto = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.fileName ?? '';
  const seg = Number(d.messageTimestamp);
  return {
    instancia: String(ev.instance ?? ''), direcao: key.fromMe ? 'sai' : 'entra', remoto: String(key.remoteJid).replace(/@.*/, ''),
    nome: key.fromMe ? '' : String(d.pushName ?? ''), tipo: String(d.messageType ?? Object.keys(m)[0] ?? ''), texto: String(texto),
    msg_id: key.id ? String(key.id) : null, ts: Number.isFinite(seg) && seg > 0 ? new Date(seg * 1000) : new Date(),
  };
}

export async function gravarMensagem(pool: Pool, m: MensagemWa, payload: unknown, enviadoPor: number | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO wa_mensagens (instancia, direcao, remoto, nome, tipo, texto, msg_id, enviado_por, ts, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (msg_id) DO UPDATE SET enviado_por = COALESCE(wa_mensagens.enviado_por, EXCLUDED.enviado_por)`,
    [m.instancia, m.direcao, m.remoto, m.nome, m.tipo, m.texto, m.msg_id, enviadoPor, m.ts, JSON.stringify(payload ?? null)]);
}
