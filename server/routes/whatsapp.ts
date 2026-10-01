import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from '../settings.js';
import { evolutionConfig } from '../tools/evolution.js';
import { WA_EVENTOS, WA_KEYS, ensureWhatsappTable, gravarMensagem } from '../whatsapp.js';
import { contatoDoDestino, hashToken } from '../wa/gateway.js';

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

    // ---------- apps do gateway (orion-wa) e regras de entrada; spec 2026-10-01-gateway-whatsapp ----------
    const novoToken = () => `wa_${randomBytes(24).toString('hex')}`;
    const apelidosValidos = (a: unknown) => (Array.isArray(a) ? a : []).filter((x): x is string => x === 'alertas' || x === 'conversa');

    dono.get('/api/whatsapp/apps', async () => {
      const [apps, regras, apelidos] = await Promise.all([
        app.pool.query(`SELECT a.id, a.nome, a.webhook_url, a.apelidos, a.limite_diario, a.ativo,
            (SELECT count(*)::int FROM wa_mensagens m WHERE m.app = a.nome AND m.direcao = 'sai' AND m.ts >= date_trunc('day', now())) AS enviados_hoje,
            (SELECT count(*)::int FROM wa_repasses p WHERE p.app_id = a.id AND p.status = 'pendente') AS pendentes,
            (SELECT count(*)::int FROM wa_repasses p WHERE p.app_id = a.id AND p.status = 'desistiu') AS falhos,
            (SELECT max(erro) FROM wa_repasses p WHERE p.app_id = a.id AND p.status <> 'ok') AS ultimo_erro
          FROM wa_apps a ORDER BY a.nome`),
        app.pool.query('SELECT id, app_id, contato, modo, nome FROM wa_regras ORDER BY modo, nome, contato'),
        app.pool.query('SELECT apelido, instancia FROM wa_apelidos ORDER BY apelido'),
      ]);
      return { apps: apps.rows, regras: regras.rows, apelidos: apelidos.rows };
    });

    /** Grupos da instância (para liberar com um clique) e contatos que falaram com o número recentemente. */
    dono.get('/api/whatsapp/contatos', async () => {
      const instancia = await getSetting(app.pool, WA_KEYS.instancia);
      const grupos: any[] = instancia ? await evo(`/group/fetchAllGroups/${encodeURIComponent(instancia)}?getParticipants=false`).catch(() => []) : [];
      const { rows } = await app.pool.query(
        `SELECT DISTINCT ON (remoto) remoto AS contato, nome FROM wa_mensagens
          WHERE direcao = 'entra' AND remoto !~ '^120363' AND ts > now() - interval '30 days' ORDER BY remoto, ts DESC LIMIT 200`);
      return { grupos: (Array.isArray(grupos) ? grupos : []).map(g => ({ contato: g.id, nome: g.subject ?? '' })), pessoas: rows };
    });

    dono.post<{ Body: { nome?: string; webhook_url?: string; apelidos?: string[]; limite_diario?: number } }>('/api/whatsapp/apps', async (req, reply) => {
      const nome = (req.body?.nome ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (!nome) return reply.code(400).send({ error: 'nome do app' });
      const token = novoToken(), seg = randomBytes(24).toString('hex');
      try {
        await app.pool.query(
          `INSERT INTO wa_apps (nome, token_hash, segredo, webhook_url, apelidos, limite_diario) VALUES ($1, $2, $3, $4, $5, $6)`,
          [nome, hashToken(token), seg, req.body?.webhook_url?.trim() || null, apelidosValidos(req.body?.apelidos).length ? apelidosValidos(req.body?.apelidos) : ['alertas'], Number(req.body?.limite_diario) || 500]);
      } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: `já existe um app ${nome}` }); throw e; }
      app.log.info(`app de WhatsApp ${nome} criado por ${req.user!.email}`);
      return { token, segredo: seg }; // só aqui: o banco guarda o hash do token
    });

    dono.put<{ Params: { id: string }; Body: { webhook_url?: string | null; apelidos?: string[]; limite_diario?: number; ativo?: boolean } }>('/api/whatsapp/apps/:id', async (req) => {
      const b = req.body ?? {};
      await app.pool.query(
        `UPDATE wa_apps SET webhook_url = CASE WHEN $2::boolean THEN NULLIF($3, '') ELSE webhook_url END,
            apelidos = COALESCE($4, apelidos), limite_diario = COALESCE($5, limite_diario), ativo = COALESCE($6, ativo) WHERE id = $1`,
        [Number(req.params.id), 'webhook_url' in b, (b.webhook_url ?? '').trim(), b.apelidos ? apelidosValidos(b.apelidos) : null, b.limite_diario ?? null, b.ativo ?? null]);
      return { ok: true };
    });

    dono.post<{ Params: { id: string } }>('/api/whatsapp/apps/:id/token', async (req) => {
      const token = novoToken();
      await app.pool.query('UPDATE wa_apps SET token_hash = $2 WHERE id = $1', [Number(req.params.id), hashToken(token)]);
      return { token };
    });

    dono.delete<{ Params: { id: string } }>('/api/whatsapp/apps/:id', async (req) => {
      await app.pool.query('DELETE FROM wa_apps WHERE id = $1', [Number(req.params.id)]);
      return { ok: true };
    });

    dono.post<{ Body: { app_id?: number; contato?: string; modo?: string; nome?: string } }>('/api/whatsapp/regras', async (req, reply) => {
      const contato = contatoDoDestino((req.body?.contato ?? '').trim());
      const modo = req.body?.modo === 'conversar' ? 'conversar' : 'ouvir';
      if (!contato || !req.body?.app_id) return reply.code(400).send({ error: 'app e contato (número com DDI ou jid de grupo)' });
      try {
        await app.pool.query(
          `INSERT INTO wa_regras (app_id, contato, modo, nome) VALUES ($1, $2, $3, $4)
           ON CONFLICT (app_id, contato) DO UPDATE SET modo = EXCLUDED.modo, nome = EXCLUDED.nome`,
          [req.body.app_id, contato, modo, (req.body?.nome ?? '').trim()]);
      } catch (e: any) {
        if (e.code === '23505') return reply.code(409).send({ error: `${contato} já conversa com outro app; conversar tem um dono só` });
        throw e;
      }
      return { ok: true };
    });

    dono.delete<{ Params: { id: string } }>('/api/whatsapp/regras/:id', async (req) => {
      await app.pool.query('DELETE FROM wa_regras WHERE id = $1', [Number(req.params.id)]);
      return { ok: true };
    });
  });
}
