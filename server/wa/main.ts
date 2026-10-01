import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as dormir } from 'node:timers/promises';
import type { Pool } from 'pg';
import { createPool } from '../db.js';
import { getSetting } from '../settings.js';
import { evolutionConfig } from '../tools/evolution.js';
import { WA_KEYS, ensureWhatsappTable, gravarMensagem, lerEventoMensagem } from '../whatsapp.js';
import { MAX_TENTATIVAS, apelidoDoModo, assinatura, contatoDe, contatoDoDestino, esperaReenvio, hashToken, intervaloEnvio, limparPayload, rotaPermitida, type Modo } from './gateway.js';

/**
 * orion-wa: gateway de WhatsApp em serviço próprio (spec 2026-10-01-gateway-whatsapp). A publicação do painel
 * não o reinicia, então o webhook da Evolution, a fila de envio e o repasse para os apps não caem junto.
 * Caddy manda /wa/* e /api/whatsapp/webhook/* para cá.
 */
const PORTA = Number(process.env.WA_PORT ?? 3001);
const SERVIDOR = `${process.env.ORION_PUBLIC_URL ?? 'https://orion.bayerl.cloud'}/wa`;
const ESPERA_MAX_MS = 60_000;
const FILA_MAX = 8;

type App = { id: number; nome: string; apelidos: string[]; limite_diario: number };

export function criarGateway(pool: Pool) {
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });

  async function evo(caminho: string, init: { method?: string; body?: string } = {}) {
    const cfg = await evolutionConfig(pool);
    if (!cfg) throw new Error('Evolution sem URL/chave');
    return fetch(`${cfg.url}/${caminho}`, {
      method: init.method ?? 'GET', body: init.body, signal: AbortSignal.timeout(60_000),
      headers: { apikey: cfg.apiKey, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  }
  async function appDoToken(token: unknown): Promise<App | null> {
    if (typeof token !== 'string' || !token) return null;
    const { rows } = await pool.query('SELECT id, nome, apelidos, limite_diario FROM wa_apps WHERE token_hash = $1 AND ativo', [hashToken(token)]);
    return rows[0] ?? null;
  }
  async function instanciaDo(apelido: string): Promise<string | null> {
    const { rows } = await pool.query('SELECT instancia FROM wa_apelidos WHERE apelido = $1', [apelido]);
    return rows[0]?.instancia ?? null;
  }

  // ---- fila única por instância real: a requisição espera a vez e recebe a resposta real da Evolution ----
  const filas = new Map<string, Promise<unknown>>();
  const tamanho = new Map<string, number>();
  const ultimo = new Map<string, number>();
  function naFila<T>(inst: string, fn: () => Promise<T>): Promise<T | 'cheia' | 'expirou'> {
    const n = tamanho.get(inst) ?? 0;
    if (n >= FILA_MAX) return Promise.resolve('cheia');
    tamanho.set(inst, n + 1);
    const entrou = Date.now();
    const minha = (filas.get(inst) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (Date.now() - entrou > ESPERA_MAX_MS) return 'expirou' as const;
      const espera = (ultimo.get(inst) ?? 0) + intervaloEnvio() - Date.now();
      if (espera > 0) await dormir(espera);
      try { return await fn(); } finally { ultimo.set(inst, Date.now()); }
    }).finally(() => tamanho.set(inst, (tamanho.get(inst) ?? 1) - 1));
    filas.set(inst, minha);
    return minha;
  }

  app.get('/wa/_saude', async () => ({ ok: true }));

  app.route<{ Params: { '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'DELETE'], url: '/wa/*',
    handler: async (req, reply) => {
      const quem = await appDoToken(req.headers.apikey);
      if (!quem) return reply.code(401).send({ status: 401, error: 'Unauthorized', response: { message: 'token do app inválido' } });
      const rota = rotaPermitida(req.method, req.params['*']);
      if (!rota) return reply.code(403).send({ status: 403, error: 'Forbidden', response: { message: 'caminho não liberado no gateway do Orion' } });

      if (rota.tipo === 'instancias') {
        const r = await evo('instance/fetchInstances');
        const lista: any[] = r.ok ? await r.json() : [];
        const { rows } = await pool.query('SELECT apelido, instancia FROM wa_apelidos WHERE apelido = ANY($1)', [quem.apelidos]);
        return rows.flatMap(a => {
          const real = lista.find(i => i.name === a.instancia);
          if (!real) return [];
          const { token: _fora, ...resto } = real;
          return [{ ...resto, name: a.apelido }];
        });
      }

      const inst = quem.apelidos.includes(rota.apelido) ? await instanciaDo(rota.apelido) : null;
      if (!inst) return reply.code(404).send({ status: 404, error: 'Not Found', response: { message: [`The "${rota.apelido}" instance does not exist`] } });

      if (rota.tipo === 'estado') {
        const r = await evo(`instance/connectionState/${encodeURIComponent(inst)}`);
        const j: any = await r.json().catch(() => null);
        if (j?.instance) j.instance.instanceName = rota.apelido;
        return reply.code(r.status).send(j);
      }
      if (rota.tipo === 'leitura') {
        const url = req.raw.url ?? '';
        const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
        const r = await evo(`${rota.evo}/${encodeURIComponent(inst)}${qs}`, { method: req.method, body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}) });
        return reply.code(r.status).header('content-type', r.headers.get('content-type') ?? 'application/json').send(await r.text());
      }

      // enviar
      const corpo: any = { ...((req.body as object) ?? {}) };
      const contato = contatoDoDestino(corpo.number);
      if (rota.apelido === 'conversa') {
        const { rowCount } = await pool.query(`SELECT 1 FROM wa_regras WHERE app_id = $1 AND contato = $2 AND modo = 'conversar'`, [quem.id, contato]);
        if (!rowCount) return reply.code(403).send({ status: 403, error: 'Forbidden', response: { message: `${contato} não tem regra conversar para ${quem.nome}` } });
        corpo.delay ??= 1500; // "digitando" antes da mensagem de conversa
      }
      const { rows: [{ n }] } = await pool.query(
        `SELECT count(*)::int AS n FROM wa_mensagens WHERE app = $1 AND direcao = 'sai' AND ts >= date_trunc('day', now())`, [quem.nome]);
      if (n >= quem.limite_diario) return reply.code(429).send({ status: 429, error: 'Too Many Requests', response: { message: `limite diário de ${quem.limite_diario} envios de ${quem.nome}` } });

      const res = await naFila(inst, async () => {
        const r = await evo(`${rota.evo}/${encodeURIComponent(inst)}`, { method: 'POST', body: JSON.stringify(corpo) });
        return { status: r.status, tipo: r.headers.get('content-type') ?? 'application/json', texto: await r.text() };
      });
      if (res === 'cheia' || res === 'expirou') return reply.code(429).send({ status: 429, error: 'Too Many Requests', response: { message: `fila do número ${res}; tente de novo` } });
      if (res.status < 300) {
        const j: any = (() => { try { return JSON.parse(res.texto); } catch { return null; } })();
        await gravarMensagem(pool, { instancia: inst, direcao: 'sai', remoto: contato, nome: '', tipo: rota.evo.endsWith('Media') ? 'media' : 'conversation',
          texto: String(corpo.text ?? corpo.caption ?? corpo.fileName ?? ''), msg_id: j?.key?.id ?? null, ts: new Date() }, j, null, quem.nome).catch(e => app.log.error(e));
      }
      return reply.code(res.status).header('content-type', res.tipo).send(res.texto);
    },
  });

  // ---- webhook da Evolution: grava e enfileira o repasse para os apps com regra para o contato ----
  app.post<{ Params: { segredo: string } }>('/api/whatsapp/webhook/:segredo', async (req, reply) => {
    const s = await getSetting(pool, WA_KEYS.segredo);
    const a = Buffer.from(req.params.segredo), b = Buffer.from(s ?? '');
    if (!s || a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(404).send({ error: 'não encontrado' });
    const ev: any = req.body;
    const m = lerEventoMensagem(ev);
    if (!m) return { ok: true };
    await gravarMensagem(pool, m, ev);
    const d = Array.isArray(ev.data) ? ev.data[0] : ev.data;
    if (m.direcao !== 'entra' || String(ev.event).toLowerCase().replace('_', '.') !== 'messages.upsert') return { ok: true };
    const contato = contatoDe(String(d.key.remoteJid), d.key.remoteJidAlt ?? d.key.senderPn);
    const { rows } = await pool.query(
      `SELECT r.app_id, r.modo FROM wa_regras r JOIN wa_apps a ON a.id = r.app_id WHERE r.contato = $1 AND a.ativo AND a.webhook_url IS NOT NULL`, [contato]);
    for (const r of rows as { app_id: number; modo: Modo }[]) {
      await pool.query('INSERT INTO wa_repasses (app_id, modo, corpo) VALUES ($1, $2, $3)',
        [r.app_id, r.modo, JSON.stringify(limparPayload(ev, apelidoDoModo(r.modo), SERVIDOR))]);
    }
    if (rows.length) void repassar();
    return { ok: true };
  });

  // ---- repasse com reenvio: fila no Postgres, sobrevive a reinício ----
  let rodando = false;
  async function repassar(): Promise<void> {
    if (rodando) return;
    rodando = true;
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.modo, p.corpo, p.tentativas, a.webhook_url, a.segredo FROM wa_repasses p JOIN wa_apps a ON a.id = p.app_id
          WHERE p.status = 'pendente' AND p.proxima <= now() ORDER BY p.id LIMIT 50`);
      for (const p of rows) {
        let erro: string | null = null;
        try {
          const r = await fetch(p.webhook_url, { method: 'POST', body: p.corpo, signal: AbortSignal.timeout(15_000),
            headers: { 'Content-Type': 'application/json', 'x-orion-modo': p.modo, 'x-orion-assinatura': assinatura(p.segredo, p.corpo) } });
          if (!r.ok) erro = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
        } catch (e: any) { erro = String(e?.message ?? e); }
        const t = p.tentativas + 1;
        if (!erro) await pool.query(`UPDATE wa_repasses SET status = 'ok', tentativas = $2, erro = NULL WHERE id = $1`, [p.id, t]);
        else await pool.query(`UPDATE wa_repasses SET status = $2, tentativas = $3, erro = $4, proxima = now() + $5 * interval '1 millisecond' WHERE id = $1`,
          [p.id, t >= MAX_TENTATIVAS ? 'desistiu' : 'pendente', t, erro, esperaReenvio(t)]);
      }
    } catch (e) { app.log.error(e); } finally { rodando = false; }
  }
  const timer = setInterval(() => void repassar(), 5000);
  app.addHook('onClose', async () => clearInterval(timer));

  return app;
}

if (process.argv[1]?.endsWith('/wa/main.js')) {
  const pool = createPool();
  await ensureWhatsappTable(pool);
  const app = criarGateway(pool);
  await app.listen({ host: '127.0.0.1', port: PORTA });
}
