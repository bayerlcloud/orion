import type { Pool } from 'pg';

/** Canal WhatsApp do Orion (fase 1 do gateway): uma instância da Evolution vinculada em Configurações,
 *  webhook dela apontando para /api/whatsapp/webhook/<segredo> (servido pelo orion-wa, server/wa/main.ts), e tudo que
 *  entra ou sai gravado em wa_mensagens. */
export const WA_KEYS = { instancia: 'whatsapp_instancia', segredo: 'whatsapp_webhook_segredo' } as const;
export const WA_EVENTOS = ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'];

export async function ensureWhatsappTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_mensagens (
    id BIGSERIAL PRIMARY KEY, instancia TEXT NOT NULL, direcao TEXT NOT NULL, remoto TEXT NOT NULL, nome TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL DEFAULT '', msg_id TEXT UNIQUE, enviado_por INT,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(), payload JSONB)`);
  // Gateway (orion-wa): apps com token, regras de entrada, apelidos das instâncias e fila de repasse.
  await pool.query(`ALTER TABLE wa_mensagens ADD COLUMN IF NOT EXISTS app TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_apps (
    id SERIAL PRIMARY KEY, nome TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, segredo TEXT NOT NULL, webhook_url TEXT,
    apelidos TEXT[] NOT NULL DEFAULT '{alertas}', limite_diario INT NOT NULL DEFAULT 500, ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_regras (
    id SERIAL PRIMARY KEY, app_id INT NOT NULL REFERENCES wa_apps(id) ON DELETE CASCADE, contato TEXT NOT NULL,
    modo TEXT NOT NULL CHECK (modo IN ('ouvir', 'conversar')), nome TEXT NOT NULL DEFAULT '', UNIQUE (app_id, contato))`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS wa_regras_um_dono ON wa_regras (contato) WHERE modo = 'conversar'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_apelidos (apelido TEXT PRIMARY KEY, instancia TEXT NOT NULL)`);
  await pool.query(`INSERT INTO wa_apelidos (apelido, instancia) SELECT a, s.value FROM settings s, unnest(ARRAY['alertas', 'conversa']) a
    WHERE s.key = '${WA_KEYS.instancia}' ON CONFLICT DO NOTHING`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_repasses (
    id BIGSERIAL PRIMARY KEY, app_id INT NOT NULL REFERENCES wa_apps(id) ON DELETE CASCADE, modo TEXT NOT NULL, corpo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente', tentativas INT NOT NULL DEFAULT 0, erro TEXT, proxima TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

export type MensagemWa = { instancia: string; direcao: 'entra' | 'sai'; remoto: string; nome: string; tipo: string; texto: string; msg_id: string | null; ts: Date };

/** Lê messages.upsert (recebida) ou send.message (enviada pela API) da Evolution v2. Outros eventos devolvem null. */
export function lerEventoMensagem(ev: any): MensagemWa | null {
  if (!['messages.upsert', 'send.message'].includes(String(ev?.event ?? '').toLowerCase().replace('_', '.'))) return null;
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

export async function gravarMensagem(pool: Pool, m: MensagemWa, payload: unknown, enviadoPor: number | null = null, app: string | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO wa_mensagens (instancia, direcao, remoto, nome, tipo, texto, msg_id, enviado_por, ts, payload, app)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (msg_id) DO UPDATE SET enviado_por = COALESCE(wa_mensagens.enviado_por, EXCLUDED.enviado_por), app = COALESCE(wa_mensagens.app, EXCLUDED.app)`,
    [m.instancia, m.direcao, m.remoto, m.nome, m.tipo, m.texto, m.msg_id, enviadoPor, m.ts, JSON.stringify(payload ?? null), app]);
}
