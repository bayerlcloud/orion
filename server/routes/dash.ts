import type { FastifyInstance } from 'fastify';
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
