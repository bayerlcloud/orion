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
import { KEYS, ensureSettingsTable, getSetting, hostingerMcpServers, sdkEnv } from '../settings.js';
import { fetchRealUsage } from '../claude/realUsage.js';
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
  const turnMcpServers = async () => hostingerMcpServers(await getSetting(app.pool, KEYS.hostingerToken));
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

  /** Abas abertas do usuário no chat: lembradas entre reloads/dispositivos. */
  app.get('/api/claude/ui-state', async (req) => {
    const { rows } = await app.pool.query('SELECT claude_open_tabs, claude_active_session FROM users WHERE id = $1', [req.user!.id]);
    return { tabs: rows[0]?.claude_open_tabs ?? [], active_id: rows[0]?.claude_active_session ?? null };
  });

  app.put<{ Body: { tabs?: string[]; active_id?: string | null } }>('/api/claude/ui-state', async (req) => {
    const tabs = Array.isArray(req.body?.tabs) ? req.body!.tabs.filter(x => typeof x === 'string').slice(0, 50) : [];
    const activeId = typeof req.body?.active_id === 'string' ? req.body!.active_id : null;
    await app.pool.query('UPDATE users SET claude_open_tabs = $2, claude_active_session = $3 WHERE id = $1', [req.user!.id, JSON.stringify(tabs), activeId]);
    return { ok: true };
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
    // Limites reais da conta: chamada direta em /api/oauth/usage (mesmo endpoint que o plugin oficial
    // e o Orion antigo usam), preferindo o arquivo de credenciais do `claude auth login` (tem o escopo
    // `user:profile`; o token de `claude setup-token` não tem — ver claude/realUsage.ts e PARIDADE.md).
    // Se por algum motivo a chamada direta falhar, cai pro que já tiver persistido num result do SDK
    // (mesmo campo `rate_limits`, se algum dia vier preenchido) antes de desistir.
    let real = await fetchRealUsage(app.pool);
    if (!real) {
      const { rows: rlRows } = await app.pool.query(
        `SELECT payload->'rate_limits' AS rate_limits, payload->>'subscription_type' AS subscription_type
           FROM claude_events
          WHERE type = 'result' AND payload->>'rate_limits_available' = 'true' AND payload->'rate_limits' IS NOT NULL
          ORDER BY ts DESC LIMIT 1`);
      real = rlRows[0] ? { subscription_type: rlRows[0].subscription_type ?? null, rate_limits: rlRows[0].rate_limits } : null;
    }
    return { usage: rows, real };
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
      sessionId: id, cwd: project.path, prompt: buildPrompt(req.user!.name, prompt, attachments), isNew: true, permissionMode: mode, model: b.model || d.model || undefined, effort, env: await turnEnv(), mcpServers: await turnMcpServers(), maxBudgetUsd: d.budget,
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
    send({ type: 'hello', status: runner.status(id), pending: runner.pendingPermissions(id), commands: runner.commandsFor(id) });
    const unsub = runner.subscribe(id, send);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(hb); unsub(); });
  });

  app.post<{ Params: { id: string }; Body: { prompt?: string; permission_mode?: string; model?: string; effort?: string; attachments?: Attachment[] } }>('/api/claude/sessions/:id/messages', async (req, reply) => {
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
    // Troca de modelo no meio da sessão (seletor do compositor): mesmo padrão do modo acima — só
    // grava quando veio um valor e é diferente do atual, pra não sobrescrever com null/vazio o que
    // já foi resolvido pelo SDK num turno anterior (system/init). Sem override, segue com s.model.
    const modelOverride = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (modelOverride && modelOverride !== s.model) await app.pool.query('UPDATE claude_sessions SET model = $2 WHERE id = $1', [s.id, modelOverride]);
    const model = modelOverride || s.model || undefined;
    const effort = EFFORTS.has(req.body?.effort ?? '') ? (req.body!.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined;
    runner.startTurn({
      sessionId: s.id, cwd: s.cwd, prompt: buildPrompt(req.user!.name, prompt, attachments), isNew: false, permissionMode: mode, model, effort, env: await turnEnv(), mcpServers: await turnMcpServers(), maxBudgetUsd: (await defaults()).budget,
      systemAppend: buildSystemAppend({ projectName: s.project_name ?? 'projeto', projectPath: s.cwd, createdBy: s.creator, rules: s.rules, memories: await memoriasPara(s.project_id ?? null, req.user!.id) }),
    });
    return { ok: true, queued: runner.status(s.id) !== 'idle' };
  });

  /**
   * Troca de modo de permissão AO VIVO (mid-turno), sem esperar a próxima mensagem — bug real
   * reportado pelo Bayerl ao vivo em 28/09/2026: trocar o seletor pra "Auto" durante um turno já em
   * andamento não tinha efeito nenhum até a próxima mensagem, porque `onMode` em `ClaudePage.tsx` só
   * atualizava `useState` local; o pedido de permissão já pendente continuava se comportando pelo
   * modo antigo, sem nenhum aviso. Confirmado ao vivo (read-only) na sessão real
   * c4380a41-d263-408e-9543-4be08d1aea01: `claude_sessions.permission_mode` continuava `acceptEdits`
   * com a sessão em `waiting` num `permission_request` pendente, mesmo a UI mostrando "Auto"
   * selecionado — o valor só seria gravado no PRÓXIMO `create`/`send` (ver POST .../messages acima).
   *
   * Sempre persiste no Postgres primeiro (mesmo padrão condicional de .../messages: só grava quando
   * o valor muda) — garante que o PRÓXIMO turno já nasce certo mesmo sem Query viva agora (sessão
   * ociosa entre turnos). Depois, se há uma Query rodando agora, aplica na hora via
   * `Runner.setPermissionModeLive` (control method `Query.setPermissionMode()` do SDK — só existe
   * numa Query já criada; ver runner.ts). A chamada ao vivo é isolada em try/catch: uma falha nela
   * (ex. hiccup de rede/processo) nunca deve impedir a persistência, que já aconteceu antes.
   */
  app.post<{ Params: { id: string }; Body: { mode?: string } }>('/api/claude/sessions/:id/mode', async (req, reply) => {
    const mode = req.body?.mode;
    if (!MODES.has(mode ?? '')) return reply.code(400).send({ error: 'modo inválido' });
    const { rows } = await app.pool.query('SELECT permission_mode FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'sessão não existe' });
    if (mode !== rows[0].permission_mode) await app.pool.query('UPDATE claude_sessions SET permission_mode = $2 WHERE id = $1', [req.params.id, mode]);
    let live = false;
    try { live = await runner.setPermissionModeLive(req.params.id, mode as 'default' | 'acceptEdits' | 'plan' | 'auto'); }
    catch (e: any) { app.log.warn(`setPermissionMode ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
  });

  /** Troca de modelo AO VIVO — mesma correção/mesmo motivo do endpoint de modo acima, aplicada ao
   * seletor de modelo do compositor (`onModel`/`setModel`, `ClaudePage.tsx`). Mesma semântica de
   * override do POST .../messages: string vazia/ausente = "sem override" (não mexe no que já está
   * persistido, o modelo resolvido pelo SDK no último system/init) — só um valor de verdade grava.
   * 'default' do seletor (sem override) já chega aqui como corpo sem `model` (ver claudeApi.setModel
   * em web/src/claude/api.ts), nunca como a string literal "default". Aplica na hora via
   * `Runner.setModelLive` (control method `Query.setModel()` do SDK) quando há Query viva agora. */
  app.post<{ Params: { id: string }; Body: { model?: string } }>('/api/claude/sessions/:id/model', async (req, reply) => {
    const { rows } = await app.pool.query('SELECT model FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'sessão não existe' });
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (model && model !== rows[0].model) await app.pool.query('UPDATE claude_sessions SET model = $2 WHERE id = $1', [req.params.id, model]);
    let live = false;
    try { live = await runner.setModelLive(req.params.id, model || undefined); }
    catch (e: any) { app.log.warn(`setModel ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
  });

  /** Troca de esforço AO VIVO. Diferente de modo/modelo, `effort` nunca é persistido por sessão no
   * Postgres — é sempre reenviado explicitamente em cada create/send (ver EFFORTS acima) — então esta
   * rota só tem o lado ao vivo, via `Runner.setEffortLive` (control method `Query.applyFlagSettings()`
   * do SDK, que aceita `effortLevel`; o SDK não tem um `setEffort()` dedicado, mas a extensão real
   * também aplica na hora por esse caminho — ver runner.ts). Sem Query viva agora, não há o que fazer
   * aqui: o valor já vai certo no próximo create/send, que já manda `effort` explicitamente. */
  app.post<{ Params: { id: string }; Body: { effort?: string } }>('/api/claude/sessions/:id/effort', async (req, reply) => {
    const effort = req.body?.effort;
    if (!EFFORTS.has(effort ?? '')) return reply.code(400).send({ error: 'esforço inválido' });
    const { rowCount } = await app.pool.query('SELECT 1 FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    let live = false;
    try { live = await runner.setEffortLive(req.params.id, effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'); }
    catch (e: any) { app.log.warn(`setEffort ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
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
