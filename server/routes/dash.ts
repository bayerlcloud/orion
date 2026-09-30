import type { FastifyInstance } from 'fastify';
import { coletarProjetos, type Ficha } from '../projetos/coletar.js';
import { HOST_IP, HOST_LABEL, RING_SIZE, Sampler, TICK_MS } from '../dash/sampler.js';

const STAT_KEYS = ['cpu', 'iowait', 'load1', 'mem_used_pct', 'disk_util'] as const;

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const x = Math.floor(Number(v));
  if (!Number.isFinite(x)) return dflt;
  return Math.max(min, Math.min(max, x));
}

export async function dashRoutes(app: FastifyInstance) {
  const sampler = new Sampler(app.pool, { log: app.log });
  await sampler.start();
  app.addHook('onClose', async () => sampler.stop());

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.get<{ Querystring: { n?: string } }>('/api/dash/now', async (req) => {
    const n = clampInt(req.query.n, RING_SIZE, 1, RING_SIZE);
    return { host: { label: HOST_LABEL, ip: HOST_IP }, tick_ms: TICK_MS, sample: sampler.latest(), series: sampler.series(n) };
  });

  app.get<{ Querystring: { hours?: string } }>('/api/dash/history', async (req) => {
    const hours = clampInt(req.query.hours, 24, 1, 24 * 7);
    const empty = { hours, rows: [] as Record<string, unknown>[], stats: {} as Record<string, { max_24h: number | null; avg_7d: number | null }>, minutes_7d: 0 };
    try {
      const { rows } = await app.pool.query(
        `SELECT ts, data FROM dash_samples WHERE ts > now() - $1::int * interval '1 hour' ORDER BY ts`, [hours]);
      const sel = STAT_KEYS.map(k =>
        `max((data->>'${k}_max')::float) FILTER (WHERE ts > now() - interval '24 hours') AS ${k}_max_24h,
         max((data->>'${k}')::float)     FILTER (WHERE ts > now() - interval '24 hours') AS ${k}_avgmax_24h,
         avg((data->>'${k}')::float) AS ${k}_avg_7d`).join(',\n');
      const { rows: st } = await app.pool.query(
        `SELECT count(*)::int AS minutes_7d, ${sel} FROM dash_samples WHERE ts > now() - interval '7 days'`);
      const s = st[0] ?? {};
      const stats: Record<string, { max_24h: number | null; avg_7d: number | null }> = {};
      for (const k of STAT_KEYS) {
        const mx = s[`${k}_max_24h`] ?? s[`${k}_avgmax_24h`];
        stats[k] = { max_24h: mx === null || mx === undefined ? null : Number(mx), avg_7d: s[`${k}_avg_7d`] === null || s[`${k}_avg_7d`] === undefined ? null : Number(s[`${k}_avg_7d`]) };
      }
      return {
        hours,
        rows: rows.map(r => ({ ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts), ...(r.data ?? {}) })),
        stats,
        minutes_7d: Number(s.minutes_7d ?? 0),
      };
    } catch (e) {
      app.log.warn({ err: String(e) }, 'dash: histórico indisponível');
      return empty;
    }
  });

  // Atividade por usuário: quando cada um logou pela última vez e quantos comandos (prompts do usuário) mandou
  // pro Claude nos últimos 7 dias. Mesmo padrão de "último login" do /api/users (server/routes/auth.ts):
  // max(ts) em logins. "Comando" = evento user_prompt em claude_events, gravado uma vez por prompt enviado
  // (server/claude/runner.ts appendEvent), não por evento bruto do SDK (tool_use etc.) -- é o que um usuário
  // não técnico entenderia por "quantos comandos dei pro Claude essa semana".
  app.get('/api/dash/user-activity', async () => {
    const { rows } = await app.pool.query(
      `SELECT u.id, u.name,
              (SELECT max(ts) FROM logins l WHERE l.user_id = u.id) AS last_login,
              (SELECT count(*) FROM claude_events je
                 JOIN claude_sessions cs ON cs.id = je.session_id
                WHERE cs.user_id = u.id AND je.type = 'user_prompt' AND je.ts >= now() - interval '7 days') AS commands_7d
         FROM users u
        ORDER BY u.id`);
    return { users: rows.map(r => ({ id: r.id, name: r.name, last_login: r.last_login, commands_7d: Number(r.commands_7d) })) };
  });

  // Seção Projetos: a coleta demora alguns segundos (git, Cloudflare, SSH na c2, checagem da produção),
  // então fica em cache por 5 min; ?refresh=1 força. Pedidos simultâneos dividem a mesma coleta.
  let fichas: { em: number; dados: Ficha[] } | null = null;
  let coletando: Promise<Ficha[]> | null = null;
  const coletar = () => (coletando ??= coletarProjetos(app.pool, app.repoDir)
    .then(d => { fichas = { em: Date.now(), dados: d }; return d; })
    .finally(() => { coletando = null; }));

  app.get<{ Querystring: { refresh?: string } }>('/api/dash/projects', async (req) => {
    if (req.query.refresh || !fichas || Date.now() - fichas.em > 5 * 60_000) await coletar();
    return { coletado: new Date(fichas!.em).toISOString(), projetos: fichas!.dados };
  });

  app.patch<{ Params: { id: string }; Body: { prod_url?: unknown; banco?: unknown; notas?: unknown } }>('/api/dash/projects/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id inválido' });
    const b = req.body ?? {};
    const meta: Record<string, string> = {};
    for (const k of ['prod_url', 'banco', 'notas'] as const) {
      const v = typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, 2000) : '';
      if (v) meta[k] = v;
    }
    if (meta.prod_url && !/^https?:\/\/[^\s]+$/.test(meta.prod_url)) return reply.code(400).send({ error: 'URL de produção precisa começar com http:// ou https://' });
    const r = await app.pool.query('UPDATE projects SET meta = $2 WHERE id = $1', [id, meta]);
    if (!r.rowCount) return reply.code(404).send({ error: 'projeto não existe' });
    fichas = null;
    return { ok: true, meta };
  });

  app.get('/api/dash/stream', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (e: unknown) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* conexão fechada */ } };
    const latest = sampler.latest();
    send({ type: 'hello', tick_ms: TICK_MS, sample: latest });
    const unsub = sampler.subscribe(s => send({ type: 'sample', sample: s }));
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* ignora */ } }, 15_000);
    req.raw.on('close', () => { clearInterval(hb); unsub(); });
  });
}
