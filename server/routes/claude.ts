import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Runner, type Attachment, type TurnPrompt } from '../claude/runner.js';
import { pgStore } from '../claude/store.js';
import { buildSystemAppend, prefixPrompt, titleFromPrompt } from '../claude/header.js';
import { KEYS, ensureSettingsTable, getSetting, sdkEnv } from '../settings.js';
import { safeFilename } from '../driveUtils.js';

const execFile = promisify(execFileCb);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Pasta dos anexos do Claude. Padrão /srv/claude-uploads, ou CLAUDE_UPLOAD_DIR. */
export function claudeUploadDir(): string {
  return path.resolve(process.env.CLAUDE_UPLOAD_DIR ?? '/srv/claude-uploads');
}
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB por arquivo
const UPLOAD_MAX_FILES = 10;

type NewBody = { project_id?: number; prompt?: string; permission_mode?: string; model?: string; effort?: string; attachments?: Attachment[] };

export async function claudeRoutes(app: FastifyInstance) {
  const runner = new Runner({ queryFn: query, store: pgStore(app.pool), log: (m) => app.log.warn(m) });
  app.decorate('runner', runner);
  await ensureSettingsTable(app.pool);
  await app.pool.query('ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false');

  // Pasta de anexos e upload em streaming, escopado a este plugin (@fastify/multipart é fastify-plugin, sobe só até aqui).
  const uploadRoot = claudeUploadDir();
  await mkdir(uploadRoot, { recursive: true })
    .catch((e: NodeJS.ErrnoException) => app.log.warn(`CLAUDE_UPLOAD_DIR ${uploadRoot} não pôde ser criado: ${e.message}`));
  await app.register(multipart, { limits: { fileSize: UPLOAD_MAX_BYTES, files: UPLOAD_MAX_FILES, fields: 4 }, throwFileSizeLimit: false });

  /** Só aceita anexos cujo caminho real está dentro da pasta de uploads (evita path traversal / leitura arbitrária). */
  async function sanitizeAttachments(raw: unknown): Promise<Attachment[] | null> {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return null;
    if (raw.length > UPLOAD_MAX_FILES) return null;
    let rootReal: string;
    try { rootReal = await realpath(uploadRoot); } catch { rootReal = uploadRoot; }
    const out: Attachment[] = [];
    for (const a of raw as any[]) {
      const p = typeof a?.path === 'string' ? a.path : '';
      const name = typeof a?.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 200) : 'arquivo';
      const media_type = typeof a?.media_type === 'string' && a.media_type ? a.media_type : 'application/octet-stream';
      if (!p) return null;
      let rp: string;
      try { rp = await realpath(p); } catch { return null; }
      if (rp !== rootReal && !rp.startsWith(rootReal + path.sep)) return null;
      out.push({ kind: media_type.startsWith('image/') ? 'image' : 'file', media_type, name, path: rp });
    }
    return out;
  }

  /** Monta o prompt do turno: string simples quando não há anexos, senão { text, attachments }. */
  function buildPrompt(userName: string, prompt: string, attachments: Attachment[]): TurnPrompt {
    const text = prefixPrompt(userName, prompt);
    return attachments.length ? { text, attachments } : text;
  }
  const turnEnv = async () => sdkEnv(await getSetting(app.pool, KEYS.claudeToken));
  const defaults = async () => ({ mode: await getSetting(app.pool, KEYS.defaultMode), model: await getSetting(app.pool, KEYS.defaultModel), budget: Number(await getSetting(app.pool, KEYS.maxBudgetUsd)) || 5 });

  // Memórias relevantes para uma sessão: universais + do projeto + do usuário, por importância.
  async function memoriasPara(projectId: number | null, userId: number): Promise<{ title: string; summary: string; status: string; scope: 'universal' | 'projeto' | 'usuário' }[]> {
    try {
      const { rows } = await app.pool.query(
        `SELECT title, summary, status, learning_level, scope_project_id, scope_user_id FROM memories
          WHERE scope_project_id = $1 OR scope_user_id = $2 OR (scope_project_id IS NULL AND scope_user_id IS NULL)
          ORDER BY CASE status WHEN 'deus' THEN 0 WHEN 'aprendizagem' THEN 1 ELSE 2 END, learning_level DESC NULLS LAST, updated_at DESC
          LIMIT 20`, [projectId, userId]);
      return rows.map((r: any) => ({ title: r.title, summary: r.summary, status: r.status, scope: r.scope_project_id ? 'projeto' : (r.scope_user_id ? 'usuário' : 'universal') }));
    } catch { return []; }
  }

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
    const token = await getSetting(app.pool, KEYS.claudeToken);
    return { logged_in: loggedIn || !!token, via: token ? 'token' : (loggedIn ? 'login' : null), home, version, linux_user: process.env.USER ?? null };
  });

  app.get('/api/claude/projects', async () => {
    const { rows } = await app.pool.query('SELECT id, slug, name, path, rules FROM projects ORDER BY id');
    return { projects: rows };
  });

  app.get('/api/claude/sessions', async () => {
    const { rows } = await app.pool.query(
      `SELECT s.id, s.title, s.status, s.cost_usd, s.turns, s.model, s.permission_mode, s.cwd, s.last_error, s.archived, s.created_at, s.updated_at,
              u.id AS user_id, u.name AS user_name, p.slug AS project_slug, p.name AS project_name
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

  /** Upload de anexos (multipart). Salva em <uploadRoot>/<user_id>/<uuid>-<nome seguro> e devolve os metadados. */
  app.post('/api/claude/uploads', async (req, reply) => {
    const user = req.user!;
    if (!req.isMultipart()) return reply.code(400).send({ error: 'envie como multipart/form-data' });
    const dir = path.join(uploadRoot, String(user.id));
    await mkdir(dir, { recursive: true });
    const saved: (Attachment & { size: number })[] = [];
    for await (const part of req.files()) {
      const original = (part.filename || '').trim() || 'arquivo';
      const dest = path.join(dir, `${randomUUID()}-${safeFilename(original)}`);
      try {
        await pipeline(part.file, createWriteStream(dest, { flags: 'wx' }));
      } catch (e) {
        await unlink(dest).catch(() => {});
        throw e;
      }
      if (part.file.truncated) {
        await unlink(dest).catch(() => {});
        return reply.code(413).send({ error: `"${original}" passa do limite de 25 MB`, attachments: saved });
      }
      const { size } = await stat(dest);
      const media_type = part.mimetype || 'application/octet-stream';
      saved.push({ kind: media_type.startsWith('image/') ? 'image' : 'file', media_type, name: original, path: dest, size });
    }
    if (!saved.length) return reply.code(400).send({ error: 'nenhum arquivo recebido' });
    return { attachments: saved };
  });

  app.post<{ Body: NewBody }>('/api/claude/sessions', async (req, reply) => {
    const b = req.body ?? {};
    const prompt = (b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt vazio' });
    const { rows: prow } = await app.pool.query('SELECT id, name, path, rules FROM projects WHERE id = $1', [b.project_id ?? 1]);
    const project = prow[0];
    if (!project) return reply.code(400).send({ error: 'projeto não existe' });
    const d = await defaults();
    const mode = MODES.has(b.permission_mode ?? '') ? (b.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : (MODES.has(d.mode ?? '') ? (d.mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : 'acceptEdits');
    const effort = EFFORTS.has(b.effort ?? '') ? (b.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined;
    const attachments = await sanitizeAttachments(b.attachments);
    if (attachments === null) return reply.code(400).send({ error: 'anexo inválido' });
    const id = randomUUID();
    await app.pool.query(
      `INSERT INTO claude_sessions (id, user_id, project_id, title, cwd, model, permission_mode, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')`,
      [id, req.user!.id, project.id, titleFromPrompt(prompt), project.path, b.model || d.model || null, mode]);
    runner.startTurn({
      sessionId: id, cwd: project.path, prompt: buildPrompt(req.user!.name, prompt, attachments), isNew: true, permissionMode: mode, model: b.model || d.model || undefined, effort, env: await turnEnv(), maxBudgetUsd: d.budget,
      systemAppend: buildSystemAppend({ projectName: project.name, projectPath: project.path, createdBy: req.user!.name, rules: project.rules, memories: await memoriasPara(project.id, req.user!.id) }),
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

  app.post<{ Params: { id: string }; Body: { prompt?: string; permission_mode?: string; effort?: string; attachments?: Attachment[] } }>('/api/claude/sessions/:id/messages', async (req, reply) => {
    const prompt = (req.body?.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt vazio' });
    const attachments = await sanitizeAttachments(req.body?.attachments);
    if (attachments === null) return reply.code(400).send({ error: 'anexo inválido' });
    const { rows } = await app.pool.query(
      'SELECT s.id, s.cwd, s.model, s.permission_mode, s.project_id, p.name AS project_name, p.rules, u.name AS creator FROM claude_sessions s LEFT JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.user_id WHERE s.id = $1', [req.params.id]);
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'sessão não existe' });
    const mode = MODES.has(req.body?.permission_mode ?? '') ? (req.body!.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : (s.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto');
    if (mode !== s.permission_mode) await app.pool.query('UPDATE claude_sessions SET permission_mode = $2 WHERE id = $1', [s.id, mode]);
    const effort = EFFORTS.has(req.body?.effort ?? '') ? (req.body!.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined;
    runner.startTurn({
      sessionId: s.id, cwd: s.cwd, prompt: buildPrompt(req.user!.name, prompt, attachments), isNew: false, permissionMode: mode, model: s.model ?? undefined, effort, env: await turnEnv(), maxBudgetUsd: (await defaults()).budget,
      systemAppend: buildSystemAppend({ projectName: s.project_name ?? 'projeto', projectPath: s.cwd, createdBy: s.creator, rules: s.rules, memories: await memoriasPara(s.project_id ?? null, req.user!.id) }),
    });
    return { ok: true, queued: runner.status(s.id) !== 'idle' };
  });

  app.post<{ Params: { id: string }; Body: { approval_id?: string; decision?: string; message?: string } }>('/api/claude/sessions/:id/permission', async (req, reply) => {
    const d = req.body?.decision;
    if (d !== 'allow' && d !== 'allow_always' && d !== 'deny' && d !== 'answer') return reply.code(400).send({ error: 'decisão inválida' });
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

  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>('/api/claude/sessions/:id/archive', async (req) => {
    const archived = req.body?.archived !== false; // padrão: arquivar
    await app.pool.query('UPDATE claude_sessions SET archived = $2 WHERE id = $1', [req.params.id, archived]);
    return { ok: true, archived };
  });

  app.delete<{ Params: { id: string } }>('/api/claude/sessions/:id', async (req, reply) => {
    if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    await runner.stop(req.params.id);
    await app.pool.query('DELETE FROM claude_sessions WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
