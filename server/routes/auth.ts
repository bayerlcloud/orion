import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SESSION_TTL_DAYS, newSessionId, verifyPassword } from '../auth.js';

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email?: string; password?: string } }>('/api/login', async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase();
    const password = req.body?.password ?? '';
    if (!email || !password) return reply.code(400).send({ error: 'informe email e senha' });
    const { rows } = await app.pool.query(
      'SELECT id, name, email, role, linux_user, password_hash FROM users WHERE email = $1', [email]);
    const u = rows[0];
    const ok = u ? await verifyPassword(password, u.password_hash) : false;
    if (!ok) return reply.code(401).send({ error: 'email ou senha inválidos' });
    const sid = newSessionId();
    const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
    await app.pool.query('INSERT INTO web_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [sid, u.id, expires]);
    await app.pool.query('INSERT INTO logins (user_id, ip, user_agent) VALUES ($1, $2, $3)',
      [u.id, req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip, req.headers['user-agent'] ?? null]);
    reply.setCookie(SESSION_COOKIE, sid, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', expires,
    });
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role } };
  });

  app.post('/api/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) await app.pool.query('DELETE FROM web_sessions WHERE id = $1', [sid]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    return { user: req.user };
  });

  app.get('/api/users', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    const { rows } = await app.pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.linux_user, u.created_at, u.sessions_private_default,
              (SELECT max(ts) FROM logins l WHERE l.user_id = u.id) AS ultimo_login
         FROM users u ORDER BY u.id`);
    return { users: rows };
  });

  // Sessões que essa pessoa criar já nascem privadas (olhinho fechado) — pedido do Danilo
  // (09/10/2026): tudo que o Gustavo fizer, só o Danilo vê.
  app.put<{ Params: { id: string }; Body: { sessions_private_default?: boolean } }>('/api/users/:id/sessions-private-default', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    const v = !!req.body?.sessions_private_default;
    const { rowCount } = await app.pool.query('UPDATE users SET sessions_private_default = $2 WHERE id = $1', [req.params.id, v]);
    if (!rowCount) return reply.code(404).send({ error: 'usuário não existe' });
    return { ok: true, sessions_private_default: v };
  });
}
