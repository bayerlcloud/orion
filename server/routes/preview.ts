import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { apontar, hostPreview, subpastaDoProjeto } from '../preview/model.js';
import { escreverEnv, liberarCache, pastaDoApp, prepararPasta } from '../preview/pasta.js';
import { COOKIE_PREVIEW, COOKIE_TTL_MS, LOGIN_URL, PUBLICO_TTL_MS, TOKEN_TTL_MS, assinar, checarCookie, consumirUmaVez, podeAbrir, proximoPainel, publicoAtivo, urlEntrar, verificar } from '../preview/auth.js';

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

  // Estado do host (raiz? projeto com preview público?), com cache curto: o check roda a cada arquivo carregado.
  // O prazo do público (preview_publico_ate) é conferido a cada uso, então vencer não depende do cache.
  const cacheHost = new Map<string, { ehRaiz: boolean; publicoAte: string | null; ate: number }>();
  async function estadoDoHost(host: string): Promise<{ ehRaiz: boolean; publico: boolean } | null> {
    let c = cacheHost.get(host);
    if (!c || c.ate <= Date.now()) {
      const { rows } = await app.pool.query(
        `SELECT pv.user_id IS NULL AS eh_raiz, p.meta->>'preview_publico_ate' AS publico_ate
           FROM previews pv JOIN projects p ON p.id = pv.project_id WHERE pv.host = $1`, [host]);
      if (!rows[0]) return null;
      c = { ehRaiz: rows[0].eh_raiz, publicoAte: rows[0].publico_ate, ate: Date.now() + 10_000 };
      cacheHost.set(host, c);
    }
    return { ehRaiz: c.ehRaiz, publico: publicoAtivo(c.publicoAte) };
  }

  app.get('/api/preview/check', async (req, reply) => {
    const host = hostDe(req.headers['x-forwarded-host'], req.hostname);
    const cookieOk = checarCookie(req.cookies[COOKIE_PREVIEW], host, segredo()).ok;
    const e = cookieOk ? null : await estadoDoHost(host);
    if (podeAbrir({ ehRaiz: e?.ehRaiz ?? false, publico: e?.publico ?? false, cookieOk })) return reply.code(200).send('ok');
    return reply.redirect(urlEntrar(host));
  });

  // Chega aqui vindo de um preview sem cookie: logado no painel, recebe o token daquele host. Sem login
  // neste endereço do painel, tenta o outro (orion/v2, cookie separado em cada); nenhum, vai para o login.
  app.get<{ Querystring: { host?: string; tentados?: string } }>('/api/preview/entrar', async (req, reply) => {
    if (!req.user) {
      const aqui = hostDe(req.headers['x-forwarded-host'], req.hostname);
      const tentados = req.query.tentados ?? '';
      const outro = proximoPainel(aqui, tentados);
      return reply.redirect(outro ? urlEntrar(req.query.host ?? '', outro, [tentados, aqui].filter(Boolean).join(',')) : LOGIN_URL);
    }
    const host = req.query.host ?? '';
    const { rows } = await app.pool.query('SELECT 1 FROM previews WHERE host = $1', [host]);
    if (!rows[0] || !segredo()) return reply.code(404).send({ error: 'preview não existe' });
    const t = assinar({ u: req.user.id, h: host, exp: Date.now() + TOKEN_TTL_MS, j: randomUUID() }, segredo());
    return reply.redirect(`https://${host}/__orion_auth?t=${encodeURIComponent(t)}`);
  });

  // Interruptor "preview público" do projeto (só o endereço raiz; os pessoais sempre pedem login).
  // Qualquer pessoa logada liga; vale 48 h (meta.preview_publico_ate) e desliga sozinho.
  const estadoPublico = (ate: string | null, nome: string) =>
    ({ publico: publicoAtivo(ate), ate: publicoAtivo(ate) ? ate : null, host: hostPreview(null, nome) });
  app.get<{ Params: { id: string } }>('/api/projects/:id/preview-publico', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    const { rows } = await app.pool.query(
      `SELECT meta->>'preview_publico_ate' AS ate, COALESCE(meta->>'preview_host', slug) AS nome FROM projects WHERE id = $1`, [Number(req.params.id)]);
    if (!rows[0]) return reply.code(404).send({ error: 'projeto não existe' });
    return estadoPublico(rows[0].ate, rows[0].nome);
  });
  app.put<{ Params: { id: string }; Body: { publico?: boolean } }>('/api/projects/:id/preview-publico', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    const ate = req.body?.publico === true ? new Date(Date.now() + PUBLICO_TTL_MS).toISOString() : null;
    const { rows } = await app.pool.query(
      `UPDATE projects SET meta = (meta - 'preview_publico' - 'preview_publico_ate')
         || CASE WHEN $2::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('preview_publico_ate', $2::text) END
       WHERE id = $1 RETURNING COALESCE(meta->>'preview_host', slug) AS nome`, [Number(req.params.id), ate]);
    if (!rows[0]) return reply.code(404).send({ error: 'projeto não existe' });
    cacheHost.clear();
    app.log.info(`preview público do projeto ${req.params.id} ${ate ? `ligado até ${ate}` : 'desligado'} por ${req.user.name ?? req.user.id}`);
    return estadoPublico(ate, rows[0].nome);
  });
}
