import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from '../settings.js';
import { evolutionConfig } from '../tools/evolution.js';
import { WA_EVENTOS, WA_KEYS, ensureWhatsappTable, gravarMensagem } from '../whatsapp.js';

const URL_PUBLICA = process.env.ORION_PUBLIC_URL ?? 'https://orion.bayerl.cloud';

export async function whatsappRoutes(app: FastifyInstance) {
  await ensureWhatsappTable(app.pool);

  async function evo(caminho: string, init?: { method?: string; body?: unknown }) {
    const cfg = await evolutionConfig(app.pool);
    if (!cfg) throw Object.assign(new Error('Evolution sem URL/chave (aba Tools)'), { statusCode: 400 });
    const r = await fetch(`${cfg.url}${caminho}`, {
      method: init?.method ?? 'GET', signal: AbortSignal.timeout(10_000),
      headers: { apikey: cfg.apiKey, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const txt = await r.text();
    let json: any = null; try { json = JSON.parse(txt); } catch { /* corpo não-JSON */ }
    if (!r.ok) throw Object.assign(new Error(`Evolution ${r.status}: ${txt.slice(0, 200)}`), { statusCode: 502 });
    return json;
  }
  const segredo = async () => {
    let s = await getSetting(app.pool, WA_KEYS.segredo);
    if (!s) { s = randomBytes(24).toString('hex'); await setSetting(app.pool, WA_KEYS.segredo, s, null); }
    return s;
  };
  const urlWebhook = (s: string) => `${URL_PUBLICA}/api/whatsapp/webhook/${s}`;

  app.register(async (dono) => {
    dono.addHook('preHandler', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
      if (req.user.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    });

    dono.get('/api/whatsapp', async () => {
      const instancia = await getSetting(app.pool, WA_KEYS.instancia);
      const lista: any[] = await evo('/instance/fetchInstances').catch(() => []);
      const disponiveis = (Array.isArray(lista) ? lista : []).map(i => ({ nome: i.name, status: i.connectionStatus, numero: String(i.ownerJid ?? '').replace(/@.*/, ''), perfil: i.profileName ?? '' }));
      const atual = disponiveis.find(i => i.nome === instancia) ?? null;
      let webhook: { url: string; ligado: boolean; nosso: boolean } | null = null;
      if (instancia) {
        const w = await evo(`/webhook/find/${encodeURIComponent(instancia)}`).catch(() => null);
        const url = String(w?.url ?? '');
        webhook = { url: url.replace(/webhook\/[0-9a-f]{48}$/, 'webhook/<segredo>'), ligado: !!w?.enabled, nosso: url === urlWebhook(await segredo()) };
      }
      const { rows } = await app.pool.query(
        `SELECT m.id, m.direcao, m.remoto, m.nome, m.tipo, m.texto, m.ts, u.name AS enviado_por
           FROM wa_mensagens m LEFT JOIN users u ON u.id = m.enviado_por WHERE m.instancia = $1 ORDER BY m.ts DESC LIMIT 50`, [instancia ?? '']);
      return { instancia, atual, webhook, disponiveis, mensagens: rows };
    });

    /** Vincula a instância ao Orion: grava a escolha e aponta o webhook dela para cá. */
    dono.put<{ Body: { instancia?: string } }>('/api/whatsapp', async (req, reply) => {
      const nome = (req.body?.instancia ?? '').trim();
      if (!nome) return reply.code(400).send({ error: 'escolha a instância' });
      const lista: any[] = await evo('/instance/fetchInstances');
      if (!lista.some(i => i.name === nome)) return reply.code(404).send({ error: `instância ${nome} não existe na Evolution` });
      await evo(`/webhook/set/${encodeURIComponent(nome)}`, { method: 'POST', body: { webhook: { enabled: true, url: urlWebhook(await segredo()), events: WA_EVENTOS, byEvents: false, base64: false } } });
      await setSetting(app.pool, WA_KEYS.instancia, nome, req.user!.id);
      app.log.info(`WhatsApp do Orion vinculado à instância ${nome} por ${req.user!.email}`);
      return { ok: true };
    });

    dono.post<{ Body: { numero?: string; texto?: string } }>('/api/whatsapp/enviar', async (req, reply) => {
      const instancia = await getSetting(app.pool, WA_KEYS.instancia);
      const numero = (req.body?.numero ?? '').replace(/\D/g, ''), texto = (req.body?.texto ?? '').trim();
      if (!instancia) return reply.code(400).send({ error: 'nenhuma instância vinculada' });
      if (numero.length < 10 || !texto) return reply.code(400).send({ error: 'número (com DDI) e texto' });
      const r = await evo(`/message/sendText/${encodeURIComponent(instancia)}`, { method: 'POST', body: { number: numero, text: texto } });
      // O webhook também traz a própria mensagem (fromMe); o msg_id único evita duplicar.
      await gravarMensagem(app.pool, { instancia, direcao: 'sai', remoto: numero, nome: '', tipo: 'conversation', texto, msg_id: r?.key?.id ?? null, ts: new Date() }, r, req.user!.id);
      return { ok: true };
    });
  });
}
