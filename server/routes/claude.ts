import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Runner } from '../claude/runner.js';
import { pgStore } from '../claude/store.js';
import { buildSystemAppend, prefixPrompt, titleFromPrompt } from '../claude/header.js';

const execFile = promisify(execFileCb);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

type NewBody = { project_id?: number; prompt?: string; permission_mode?: string; model?: string; effort?: string };

export async function claudeRoutes(app: FastifyInstance) {
  const runner = new Runner({ queryFn: query, store: pgStore(app.pool), log: (m) => app.log.warn(m) });
  app.decorate('runner', runner);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  /** Login do Claude no servidor: existe credencial no home do processo? */
  app.get('/api/claude/status', async () => {
    const home = homedir();
    let loggedIn = false;
    try { await access(path.join(home, '.claude', '.credentials.json')); loggedIn = true; } catch { /* sem login */ }
    let version = 'indisponível';
    try { version = (await execFile('claude', ['--version'], { timeout: 8000 })).stdout.trim(); } catch { /* sem cli */ }
    return { logged_in: loggedIn, home, version, linux_user: process.env.USER ?? null };
  });

  app.get('/api/claude/projects', async () => {
    const { rows } = await app.pool.query('SELECT id, slug, name, path, rules FROM projects ORDER BY id');
    return { projects: rows };
  });

  app.get('/api/claude/sessions', async () => {
    const { rows } = await app.pool.query(
      `SELECT s.id, s.title, s.status, s.cost_usd, s.turns, s.model, s.permission_mode, s.cwd, s.last_error, s.created_at, s.updated_at,
              u.name AS user_name, p.slug AS project_slug, p.name AS project_name
         FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY s.updated_at DESC LIMIT 200`);
    const sessions = rows.map(r => ({ ...r, status: runner.status(r.id) === 'idle' && r.status === 'error' ? 'error' : runner.status(r.id), pending: runner.pendingPermissions(r.id).length }));
    return { sessions };
  });

  app.get('/api/claude/usage', async () => {
    const { rows } = await app.pool.query(
      `SELECT u.id, u.name,
              COALESCE(SUM(s.cost_usd) FILTER (WHERE s.updated_at > now() - interval '5 hours'), 0) AS cost_5h,
              COALESCE(SUM(s.cost_usd) FILTER (WHERE s.updated_at > now() - interval '7 days'), 0) AS cost_7d,
              COALESCE(SUM(s.cost_usd), 0) AS cost_total, COUNT(s.id) AS sessions
         FROM users u LEFT JOIN claude_sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.id`);
    return { usage: rows };
  });

  app.post<{ Body: NewBody }>('/api/claude/sessions', async (req, reply) => {
    const b = req.body ?? {};
    const prompt = (b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt vazio' });
    const { rows: prow } = await app.pool.query('SELECT id, name, path, rules FROM projects WHERE id = $1', [b.project_id ?? 1]);
    const project = prow[0];
    if (!project) return reply.code(400).send({ error: 'projeto não existe' });
    const mode = MODES.has(b.permission_mode ?? '') ? (b.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : 'acceptEdits';
    const effort = EFFORTS.has(b.effort ?? '') ? (b.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined;
    const id = randomUUID();
    await app.pool.query(
      `INSERT INTO claude_sessions (id, user_id, project_id, title, cwd, model, permission_mode, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')`,
      [id, req.user!.id, project.id, titleFromPrompt(prompt), project.path, b.model ?? null, mode]);
    runner.startTurn({
      sessionId: id, cwd: project.path, prompt: prefixPrompt(req.user!.name, prompt), isNew: true, permissionMode: mode, model: b.model || undefined, effort,
      systemAppend: buildSystemAppend({ projectName: project.name, projectPath: project.path, createdBy: req.user!.name, rules: project.rules }),
    });
    return { id, title: titleFromPrompt(prompt) };
  });

  app.get<{ Params: { id: string } }>('/api/claude/sessions/:id', async (req, reply) => {
    const { rows } = await app.pool.query(
      `SELECT s.*, u.name AS user_name, p.name AS project_name, p.slug AS project_slug FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = $1`, [req.params.id]);
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'sessão não existe' });
    const { rows: events } = await app.pool.query('SELECT seq, ts, type, payload FROM claude_events WHERE session_id = $1 ORDER BY seq', [s.id]);
    return { session: { ...s, status: runner.status(s.id) === 'idle' ? s.status : runner.status(s.id) }, events, pending: runner.pendingPermissions(s.id) };
  });

  app.get<{ Params: { id: string } }>('/api/claude/sessions/:id/stream', async (req, reply) => {
    const id = req.params.id;
    const { rowCount } = await app.pool.query('SELECT 1 FROM claude_sessions WHERE id = $1', [id]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
    send({ type: 'hello', status: runner.status(id), pending: runner.pendingPermissions(id) });
    const unsub = runner.subscribe(id, send);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(hb); unsub(); });
  });

  app.post<{ Params: { id: string }; Body: { prompt?: string; permission_mode?: string; effort?: string } }>('/api/claude/sessions/:id/messages', async (req, reply) => {
    const prompt = (req.body?.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt vazio' });
    const { rows } = await app.pool.query(
      'SELECT s.id, s.cwd, s.model, s.permission_mode, p.name AS project_name, p.rules, u.name AS creator FROM claude_sessions s LEFT JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.user_id WHERE s.id = $1', [req.params.id]);
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'sessão não existe' });
    const mode = MODES.has(req.body?.permission_mode ?? '') ? (req.body!.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : (s.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto');
    if (mode !== s.permission_mode) await app.pool.query('UPDATE claude_sessions SET permission_mode = $2 WHERE id = $1', [s.id, mode]);
    const effort = EFFORTS.has(req.body?.effort ?? '') ? (req.body!.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined;
    runner.startTurn({
      sessionId: s.id, cwd: s.cwd, prompt: prefixPrompt(req.user!.name, prompt), isNew: false, permissionMode: mode, model: s.model ?? undefined, effort,
      systemAppend: buildSystemAppend({ projectName: s.project_name ?? 'projeto', projectPath: s.cwd, createdBy: s.creator, rules: s.rules }),
    });
    return { ok: true, queued: runner.status(s.id) !== 'idle' };
  });

  app.post<{ Params: { id: string }; Body: { approval_id?: string; decision?: string; message?: string } }>('/api/claude/sessions/:id/permission', async (req, reply) => {
    const d = req.body?.decision;
    if (d !== 'allow' && d !== 'allow_always' && d !== 'deny') return reply.code(400).send({ error: 'decisão inválida' });
    const ok = await runner.decide(req.params.id, req.body?.approval_id ?? '', d, req.user!.id, req.body?.message);
    if (!ok) return reply.code(404).send({ error: 'pedido de permissão não está pendente' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/claude/sessions/:id/stop', async (req) => {
    await runner.stop(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/claude/sessions/:id/rename', async (req, reply) => {
    const title = (req.body?.title ?? '').trim().slice(0, 120);
    if (!title) return reply.code(400).send({ error: 'título vazio' });
    await app.pool.query('UPDATE claude_sessions SET title = $2 WHERE id = $1', [req.params.id, title]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/claude/sessions/:id', async (req, reply) => {
    if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    await runner.stop(req.params.id);
    await app.pool.query('DELETE FROM claude_sessions WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
