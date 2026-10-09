import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createPool, type User } from './db.js';
import { migrate } from './migrations.js';
import { SESSION_COOKIE } from './auth.js';
import { COOKIE_PREVIEW, checarCookie } from './preview/auth.js';
import { authRoutes } from './routes/auth.js';
import { specRoutes } from './routes/spec.js';
import { driveRoutes } from './routes/drive.js';
import { claudeRoutes } from './routes/claude.js';
import { settingsRoutes } from './routes/settings.js';
import { dashRoutes } from './routes/dash.js';
import { filesRoutes } from './routes/files.js';
import { memoriesRoutes } from './routes/memories.js';
import { profileRoutes } from './routes/profile.js';
import { tasksRoutes } from './routes/tasks.js';
import { toolsRoutes } from './routes/tools.js';
import { curadoriaRoutes } from './routes/curadoria.js';
import { deployRoutes } from './routes/deploy.js';
import { previewRoutes } from './routes/preview.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { outputStylesRoutes } from './routes/outputStyles.js';
import { conectorRoutes } from './routes/conector.js';
import { iniciarCofreCompartilhado, iniciarReaperAbasCofre } from './tools/cofre.js';
import { whatsappRoutes } from './routes/whatsapp.js';

declare module 'fastify' {
  interface FastifyInstance { pool: Pool; repoDir: string; runner: import('./claude/runner.js').Runner }
  interface FastifyRequest { user: User | null }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..', 'web');

async function main() {
  const app = Fastify({ logger: true, trustProxy: true });
  const pool = createPool();
  await migrate(pool);
  app.decorate('pool', pool);
  app.decorate('repoDir', process.env.ORION_REPO ?? path.resolve(here, '..', '..'));
  app.decorateRequest('user', null);

  await app.register(cookie);

  app.addHook('onRequest', async (req) => {
    req.user = null;
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) {
      // Preview do próprio Orion (<pessoa>.orionpreview): o front de dev chama este /api pelo host do
      // preview, onde não existe orion_session. O cookie do preview (emitido só para quem estava logado
      // no painel, preso ao host) vale como login, mas só nos hosts de preview do projeto Orion.
      const pv = req.cookies[COOKIE_PREVIEW];
      if (!pv) return;
      const c = checarCookie(pv, req.hostname, process.env.SESSION_SECRET ?? '');
      if (!c.ok) return;
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.linux_user
           FROM previews pv JOIN projects p ON p.id = pv.project_id, users u
          WHERE pv.host = $1 AND p.path = $2 AND u.id = $3`, [req.hostname, app.repoDir, c.u]);
      req.user = rows[0] ?? null;
      return;
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.linux_user
         FROM web_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`, [sid]);
    req.user = rows[0] ?? null;
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(specRoutes);
  await app.register(driveRoutes);
  await app.register(claudeRoutes);
  await app.register(settingsRoutes);
  await app.register(dashRoutes);
  await app.register(filesRoutes);
  await app.register(memoriesRoutes);
  await app.register(profileRoutes);
  await app.register(tasksRoutes);
  await app.register(toolsRoutes);
  await app.register(curadoriaRoutes);
  await app.register(deployRoutes);
  await app.register(previewRoutes);
  await app.register(marketplaceRoutes);
  await app.register(outputStylesRoutes);
  await app.register(conectorRoutes);
  await app.register(whatsappRoutes);

  // wildcard: true = lê o disco a cada pedido. Com false, só os arquivos que existiam no boot tinham
  // rota: um `npm run build` sem restart deixava o index.html novo apontando pra assets sem rota
  // (tela em branco, 29/09/2026). Arquivo inexistente cai no setNotFoundHandler abaixo.
  await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'não encontrado' });
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '127.0.0.1' });
  iniciarCofreCompartilhado(m => app.log.warn(m));
  iniciarReaperAbasCofre(m => app.log.warn(m));
}

main().catch((e) => { console.error(e); process.exit(1); });
