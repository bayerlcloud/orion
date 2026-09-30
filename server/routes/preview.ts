import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { apontar, subpastaDoProjeto } from '../preview/model.js';
import { escreverEnv, liberarCache, pastaDoApp, prepararPasta } from '../preview/pasta.js';
import { COOKIE_PREVIEW, COOKIE_TTL_MS, TOKEN_TTL_MS, assinar, checarCookie, consumirUmaVez, verificar } from '../preview/auth.js';

/**
 * Preview ao vivo (spec 2026-09-30-preview-design, Parte 1):
 * - /api/preview/open: botão Preview da sessão; aponta o preview pessoal para a pasta da sessão e
 *   manda o navegador para o preview com um token de 60 s.
 * - /__orion_auth: chamado no host do preview (o Caddy repassa); troca o token pelo cookie daquele host.
 * - /api/preview/check: `forward_auth` do Caddy em todo acesso ao preview pessoal.
 */
export async function previewRoutes(app: FastifyInstance) {
  const segredo = () => process.env.SESSION_SECRET ?? '';
  const hostDe = (h: string | string[] | undefined, fallback: string) => (Array.isArray(h) ? h[0] : h)?.split(',')[0].trim() || fallback;

  app.get<{ Querystring: { session?: string } }>('/api/preview/open', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    if (!segredo()) return reply.code(503).send({ error: 'SESSION_SECRET ausente' });
    const { rows } = await app.pool.query(
      `SELECT s.user_id, s.project_id, s.cwd, p.path AS project_path FROM claude_sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = $1`,
      [req.query.session ?? '']);
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'sessão sem projeto ou inexistente' });
    if (s.user_id !== req.user.id && req.user.role !== 'owner') return reply.code(403).send({ error: 'sessão de outra pessoa' });
    const row = await apontar(app.pool, req.user.id, s.project_id, s.cwd);
    const sub = await subpastaDoProjeto(app.pool, s.project_id);
    try {
      await prepararPasta(s.cwd, s.project_path);
      await liberarCache(pastaDoApp(s.cwd, sub), undefined, s.cwd);
    } catch (e) {
      return reply.code(500).send({ error: `não consegui preparar a pasta do preview: ${e instanceof Error ? e.message : e}` });
    }
    try {
      const env = await escreverEnv(row, undefined, undefined, sub);
      if (env.erroParar) app.log.warn(`preview: não consegui parar o vite antigo de ${row.host}: ${env.erroParar}`);
    } catch (e) {
      return reply.code(500).send({ error: `não consegui gravar o .env do preview: ${e instanceof Error ? e.message : e}` });
    }
    const t = assinar({ u: req.user.id, h: row.host, exp: Date.now() + TOKEN_TTL_MS, j: randomUUID() }, segredo());
    return reply.redirect(`https://${row.host}/__orion_auth?t=${encodeURIComponent(t)}`);
  });

  app.get<{ Querystring: { t?: string } }>('/__orion_auth', async (req, reply) => {
    const host = hostDe(req.headers['x-forwarded-host'], req.hostname);
    const v = segredo() && req.query.t ? verificar(req.query.t, host, segredo()) : null;
    if (!v?.j || !consumirUmaVez(v.j, Date.now() + TOKEN_TTL_MS)) return reply.code(403).type('text/plain').send('Link de preview vencido ou já usado. Abra o preview de novo pelo botão no Orion.');
    const exp = Date.now() + COOKIE_TTL_MS;
    reply.setCookie(COOKIE_PREVIEW, assinar({ u: v.u, h: host, exp }, segredo()), { path: '/', httpOnly: true, secure: true, sameSite: 'lax', expires: new Date(exp) });
    return reply.redirect('/');
  });

  app.get('/api/preview/check', async (req, reply) => {
    const host = hostDe(req.headers['x-forwarded-host'], req.hostname);
    const r = checarCookie(req.cookies[COOKIE_PREVIEW], host, segredo());
    return r.ok ? reply.code(200).send('ok') : reply.redirect(r.redirect);
  });
}
