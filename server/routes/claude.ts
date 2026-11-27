import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { transcribe } from '../claude/transcribe.js';
import {
  PERMISSION_BEHAVIORS, settingsPathForScope, readPermissionRuleSet, mutatePermissionRuleSet,
  validateRuleText, addRule, removeRule, replaceRule, type PermissionBehavior, type PermissionScope,
} from '../claude/permissionRules.js';
import { readProjectHooks } from '../claude/hooks.js';
import { listProjectSkills, setSkillOverride } from '../claude/skills.js';
import { validateGroupName, sanitizeGroupName } from '../claude/groups.js';
import { access, appendFile, mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { IMAGE_MEDIA_TYPES, type Attachment, type TurnPrompt } from '../claude/runner.js';
import { tituloCurto } from '../claude/titulo.js';
import { cacheFora, foraDaSessao, marcarVista } from '../claude/fora.js';
import { arquivosDoProjeto, rankearArquivos } from '../claude/mencaoArquivos.js';
import { prefixPrompt, titleFromPrompt } from '../claude/header.js';
import { estiloConhecido } from '../tools/outputStyles.js';
import { KEYS, ensureSettingsTable, getSetting } from '../settings.js';
import { ensureTriagemSombraTable } from '../memories/triagemSombra.js';
import { projetoIntegracao } from '../claude/montarTurno.js';
import { createWorktreeForProject, worktreeDoUsuario } from '../claude/worktree.js';
import { slugPessoa, temPreview } from '../preview/model.js';
import { ensureGithubAccountsTable, listarContasGithub } from '../tools/githubAccounts.js';
import { desarquivar, listarConectoresClaudeAi, enxugarToolUseResult, semWorkflowProgress, truncarToolResult } from '../tools/leveza.js';
import { ensureCloudflareAccountsTable } from '../tools/cloudflareAccounts.js';
import { ensureGoogleCloudAccountsTable } from '../tools/googleCloudAccounts.js';
import { fetchRealUsage } from '../claude/realUsage.js';
import { ULTRACODE, resolveUltracode } from '../claude/ultracode.js';
import { safeFilename } from '../driveUtils.js';
import { MotorIndisponivel } from '../claude/motorSocket.js';

// Retomada e vigia moraram aqui até o plano B1 (T2); agora vivem em claude/retomada.ts junto do motor.
// Re-export pra tests/resume.test.ts e quem mais importar daqui.
export { RESUME_PROMPT, NAO_RETOMADA, VIGIA_PROMPT, shouldResume, notaDeploy, DEPLOY_OK_MARCA } from '../claude/retomada.js';

const execFile = promisify(execFileCb);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
// 'ultracode' é o degrau extra do seletor (ver server/claude/ultracode.ts): aceito e persistido
// como está em claude_sessions.effort, mas SEMPRE traduzido por resolveUltracode antes do SDK.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', ULTRACODE]);
const tabListeners = new Map<number, Set<(e: unknown) => void>>();

/** Pasta dos anexos do Claude. Padrão /srv/claude-uploads, ou CLAUDE_UPLOAD_DIR. */
export function claudeUploadDir(): string {
  return path.resolve(process.env.CLAUDE_UPLOAD_DIR ?? '/srv/claude-uploads');
}
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB por arquivo
const UPLOAD_MAX_FILES = 20;
/** Bytes pendentes por aba no SSE da sessão antes de derrubar a conexão (ver rota /stream). */
const SSE_BUFFER_MAX = 4 * 1024 * 1024;
/** Ao abrir a sessão, quantos bytes (brutos, do banco) mais recentes voltam intactos; o resto vem resumido (ver GET /sessions/:id). */
const SESSAO_BYTES_INTACTOS = 8 * 1024 * 1024;

/** SSE abertos em /api/claude/sessions/:id/stream. Em modo socket, o hello do runner (reconexão) fecha todos:
 * o EventSource do navegador reconecta e recarrega o histórico pelo GET (nenhum replay de eventos é preciso). */
const sseAbertos = new Set<ServerResponse>();
export function fecharSseAbertos(): void {
  for (const res of sseAbertos) res.end();
  sseAbertos.clear();
}

/**
 * Um caminho real (já resolvido por `realpath`) está dentro de uma raiz (ou é a própria raiz)? Mesma
 * checagem anti path-traversal usada tanto no upload (`sanitizeAttachments`, abaixo) quanto na rota
 * que serve o anexo de volta pra miniatura do histórico (`GET /api/claude/attachments`, popup de
 * imagem de 28/09/2026 — ver PARIDADE.md). Extraída como função pura de nível de módulo (fora de
 * `claudeRoutes`) só pra poder testar essa regra isolada do Fastify — comportamento idêntico ao que
 * já existia inline aqui antes desta rodada, só fatorado pra reuso + teste.
 */
export function isUnderRoot(real: string, root: string): boolean {
  return real === root || real.startsWith(root + path.sep);
}

type NewBody = { project_id?: number | null; prompt?: string; permission_mode?: string; model?: string; effort?: string; attachments?: Attachment[]; worktree_name?: string };

export async function claudeRoutes(app: FastifyInstance) {
  // Motor das sessões (claude/motor.ts): local ou socket (orion-runner). Quem o cria e hospeda é o index.ts.
  const motor = app.motor;
  // Runner fora (modo socket, reiniciando): escrita responde 503 e o front tenta de novo; leitura segue pelo espelho/DB.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof MotorIndisponivel) return reply.code(503).send({ error: 'motor de sessões indisponível; tente em alguns segundos' });
    throw err; // segue pro tratador padrão (500 com log)
  });
  await ensureSettingsTable(app.pool);
  await ensureTriagemSombraTable(app.pool); // piloto Laya (docs/plans/2026-10-07-piloto-laya-triagem.md), modo sombra
  // As tabelas de contas nascem aqui também (em produção já existem): a retomada pós-restart vive no motor (hospedarMotor) e sobe antes deste plugin.
  await ensureGithubAccountsTable(app.pool);
  await ensureCloudflareAccountsTable(app.pool);
  await ensureGoogleCloudAccountsTable(app.pool);
  await app.pool.query('ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false');
  await app.pool.query('ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false');
  // Output style por sessão (nullable = sem estilo, o "default" do CLI) — ver server/tools/outputStyles.ts
  // e a rota POST /:id/output-style abaixo. Mesmo padrão do archived acima: ALTER aqui, sem disputar migrations.ts.
  await app.pool.query('ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS output_style TEXT');

  // Pasta de anexos e upload em streaming, escopado a este plugin (@fastify/multipart é fastify-plugin, sobe só até aqui).
  const uploadRoot = claudeUploadDir();
  const neutroDir = process.env.ORION_NEUTRO_DIR ?? path.join(homedir(), 'neutro');
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
      if (!isUnderRoot(rp, rootReal)) return null;
      out.push({ kind: media_type.startsWith('image/') ? 'image' : 'file', media_type, name, path: rp });
    }
    return out;
  }

  /** Monta o prompt do turno: string simples quando não há anexos, senão { text, attachments }. */
  function buildPrompt(userName: string, prompt: string, attachments: Attachment[]): TurnPrompt {
    const text = prefixPrompt(userName, prompt);
    return attachments.length ? { text, attachments } : text;
  }
  const defaults = async () => ({ mode: await getSetting(app.pool, KEYS.defaultMode), model: await getSetting(app.pool, KEYS.defaultModel) });

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

  /** Erro de render do front (ErrorBoundary em main.tsx): antes disso a 1ª ocorrência recarregava
   * sozinho sem deixar rastro nenhum, impossível diagnosticar (relato do Danilo, 10/11/2026). */
  app.post<{ Body: { message?: string; stack?: string; url?: string } }>('/api/claude/client-error', async (req) => {
    app.log.error({ userId: req.user?.id, ...req.body }, '[client-error] render travou no front');
    return { ok: true };
  });

  /** Abas abertas do usuário no chat: lembradas entre reloads/dispositivos. */
  app.get('/api/claude/ui-state', async (req) => {
    const { rows } = await app.pool.query('SELECT claude_open_tabs, claude_active_session FROM users WHERE id = $1', [req.user!.id]);
    return { tabs: rows[0]?.claude_open_tabs ?? [], active_id: rows[0]?.claude_active_session ?? null };
  });

  app.put<{ Body: { tabs?: string[]; active_id?: string | null; client?: string } }>('/api/claude/ui-state', async (req) => {
    const tabs = Array.isArray(req.body?.tabs) ? req.body!.tabs.filter(x => typeof x === 'string').slice(0, 50) : [];
    const activeId = typeof req.body?.active_id === 'string' ? req.body!.active_id : null;
    await app.pool.query('UPDATE users SET claude_open_tabs = $2, claude_active_session = $3 WHERE id = $1', [req.user!.id, JSON.stringify(tabs), activeId]);
    for (const send of tabListeners.get(req.user!.id) ?? []) send({ tabs, client: req.body?.client });
    return { ok: true };
  });

  // Abas abertas em tempo real entre guias/dispositivos do mesmo usuário: cada PUT acima avisa
  // todas as conexões deste usuário. ponytail: em memória, um processo só; se virar cluster, LISTEN/NOTIFY.
  app.get('/api/claude/ui-state/stream', async (req, reply) => {
    const uid = req.user!.id;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
    let set = tabListeners.get(uid);
    if (!set) tabListeners.set(uid, set = new Set());
    set.add(send);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(hb); set!.delete(send); if (!set!.size) tabListeners.delete(uid); });
  });

  app.get('/api/claude/projects', async () => {
    const { rows } = await app.pool.query<{ id: number; slug: string; name: string; path: string; rules: string | null; sub: string | null; production_url: string | null }>(
      "SELECT id, slug, name, path, rules, meta->>'preview_dir' AS sub, meta->>'production_url' AS production_url FROM projects ORDER BY id");
    const projects = await Promise.all(rows.map(async ({ sub, production_url, ...r }) =>
      ({ ...r, temPreview: await temPreview(r.path, sub), productionUrl: production_url })));
    return { projects };
  });

  // Skills/hooks do projeto e regras de permissão: restauradas em 01/10/2026 (sumiram sem querer no commit 690b817).
  async function resolveRuleScopePath(scope: unknown, projectId: unknown): Promise<{ ok: true; path: string } | { ok: false; code: number; error: string }> {
    if (scope !== 'user' && scope !== 'project') return { ok: false, code: 400, error: 'scope inválido (use "user" ou "project")' };
    if (scope === 'user') return { ok: true, path: settingsPathForScope('user', { homeDir: homedir() }) };
    const pid = Number(projectId);
    if (!pid) return { ok: false, code: 400, error: 'project_id é obrigatório pro scope "project"' };
    const { rows } = await app.pool.query('SELECT path FROM projects WHERE id = $1', [pid]);
    const projectPath = rows[0]?.path;
    if (!projectPath) return { ok: false, code: 404, error: 'projeto não encontrado' };
    try {
      return { ok: true, path: settingsPathForScope('project', { homeDir: homedir(), projectPath }) };
    } catch (e: any) {
      return { ok: false, code: 500, error: e?.message ?? 'projeto com caminho inválido' };
    }
  }
  function requireOwnerForUserScope(scope: unknown, req: { user?: { role: string } | null }): string | null {
    if (scope === 'user' && req.user?.role !== 'owner') return 'só o admin edita regras de usuário (afeta todos os projetos e usuários do Orion)';
    return null;
  }

  type PermRuleBody = { scope?: PermissionScope; project_id?: number; behavior?: PermissionBehavior; rule?: string };
  type PermRuleEditBody = PermRuleBody & { old_behavior?: PermissionBehavior; old_rule?: string };
  app.get<{ Params: { id: string } }>('/api/claude/projects/:id/hooks', async (req, reply) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return reply.code(400).send({ error: 'id inválido' });
    const { rows } = await app.pool.query('SELECT path FROM projects WHERE id = $1', [projectId]);
    if (!rows[0]) return reply.code(404).send({ error: 'projeto não existe' });
    return await readProjectHooks(rows[0].path);
  });
  app.get<{ Params: { id: string } }>('/api/claude/projects/:id/skills', async (req, reply) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return reply.code(400).send({ error: 'id inválido' });
    const { rows } = await app.pool.query('SELECT path FROM projects WHERE id = $1', [projectId]);
    if (!rows[0]) return reply.code(404).send({ error: 'projeto não existe' });
    const skills = await listProjectSkills(app.pool, projectId, rows[0].path);
    return { skills };
  });
  app.post<{ Params: { id: string }; Body: { name?: string; enabled?: boolean } }>('/api/claude/projects/:id/skills', async (req, reply) => {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId)) return reply.code(400).send({ error: 'id inválido' });
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'nome da skill é obrigatório' });
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled deve ser booleano' });
    const { rowCount } = await app.pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (!rowCount) return reply.code(404).send({ error: 'projeto não existe' });
    await setSkillOverride(app.pool, projectId, name, req.body.enabled, req.user!.id);
    return { ok: true };
  });
  app.get<{ Querystring: { scope?: string; project_id?: string } }>('/api/claude/permission-rules', async (req, reply) => {
    const r = await resolveRuleScopePath(req.query.scope, req.query.project_id);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const { set, error } = await readPermissionRuleSet(r.path);
    return { ...set, ...(error ? { error } : {}) };
  });
  app.post<{ Body: PermRuleBody }>('/api/claude/permission-rules', async (req, reply) => {
    const { scope, project_id, behavior, rule } = req.body ?? {};
    const denied = requireOwnerForUserScope(scope, req);
    if (denied) return reply.code(403).send({ error: denied });
    if (!behavior || !(PERMISSION_BEHAVIORS as readonly string[]).includes(behavior)) return reply.code(400).send({ error: 'behavior inválido (use allow, ask ou deny)' });
    const msg = validateRuleText(rule ?? '');
    if (msg) return reply.code(400).send({ error: msg });
    const r = await resolveRuleScopePath(scope, project_id);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    try {
      return await mutatePermissionRuleSet(r.path, (s) => addRule(s, behavior, rule!.trim()));
    } catch (e: any) { return reply.code(500).send({ error: e?.message ?? 'erro ao salvar' }); }
  });
  app.put<{ Body: PermRuleEditBody }>('/api/claude/permission-rules', async (req, reply) => {
    const { scope, project_id, behavior, rule, old_behavior, old_rule } = req.body ?? {};
    const denied = requireOwnerForUserScope(scope, req);
    if (denied) return reply.code(403).send({ error: denied });
    if (!behavior || !(PERMISSION_BEHAVIORS as readonly string[]).includes(behavior)) return reply.code(400).send({ error: 'behavior inválido (use allow, ask ou deny)' });
    if (!old_behavior || !(PERMISSION_BEHAVIORS as readonly string[]).includes(old_behavior) || !old_rule) return reply.code(400).send({ error: 'regra original ausente' });
    const msg = validateRuleText(rule ?? '');
    if (msg) return reply.code(400).send({ error: msg });
    const r = await resolveRuleScopePath(scope, project_id);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    try {
      return await mutatePermissionRuleSet(r.path, (s) => replaceRule(s, old_behavior, old_rule, behavior, rule!.trim()));
    } catch (e: any) { return reply.code(500).send({ error: e?.message ?? 'erro ao salvar' }); }
  });
  app.delete<{ Body: PermRuleBody }>('/api/claude/permission-rules', async (req, reply) => {
    const { scope, project_id, behavior, rule } = req.body ?? {};
    const denied = requireOwnerForUserScope(scope, req);
    if (denied) return reply.code(403).send({ error: denied });
    if (!behavior || !(PERMISSION_BEHAVIORS as readonly string[]).includes(behavior) || !rule) return reply.code(400).send({ error: 'regra inválida' });
    const r = await resolveRuleScopePath(scope, project_id);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    try {
      return await mutatePermissionRuleSet(r.path, (s) => removeRule(s, behavior, rule));
    } catch (e: any) { return reply.code(500).send({ error: e?.message ?? 'erro ao remover' }); }
  });

  // Pastas de sessão: rotas restauradas em 30/09/2026 (tinham sumido sem querer no commit 690b817).
  /**
   * Pastas nomeadas de sessões ("Aba Claude" — ver PARIDADE.md, item 12 da seção 13). Compartilhadas
   * entre todos os usuários, mesmo modelo de "caixa compartilhada" que `GET /api/claude/sessions` já
   * tem (nenhuma das duas rotas filtra por dono) — `created_by` só serve de auditoria, nunca de
   * escopo de visibilidade. Ordenadas por `created_at` (ordem de criação; sem reordenação manual
   * nesta rodada, ver PARIDADE.md) — o cliente (`groupSessions(..., 'folder', now, folders)` em
   * web/src/claude/mapper.ts) espera exatamente essa ordem.
   */
  app.get('/api/claude/session-groups', async () => {
    const { rows } = await app.pool.query('SELECT id, name, created_at FROM claude_session_groups ORDER BY created_at ASC, id ASC');
    return { groups: rows };
  });

  app.post<{ Body: { name?: string } }>('/api/claude/session-groups', async (req, reply) => {
    const err = validateGroupName(req.body?.name ?? '');
    if (err) return reply.code(400).send({ error: err });
    const id = randomUUID();
    const name = sanitizeGroupName(req.body!.name!);
    await app.pool.query('INSERT INTO claude_session_groups (id, name, created_by) VALUES ($1, $2, $3)', [id, name, req.user!.id]);
    return { id, name };
  });

  app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/claude/session-groups/:id/rename', async (req, reply) => {
    const err = validateGroupName(req.body?.name ?? '');
    if (err) return reply.code(400).send({ error: err });
    const name = sanitizeGroupName(req.body!.name!);
    const { rowCount } = await app.pool.query('UPDATE claude_session_groups SET name = $2, updated_at = now() WHERE id = $1', [req.params.id, name]);
    if (!rowCount) return reply.code(404).send({ error: 'pasta não existe' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/claude/session-groups/:id', async (req, reply) => {
    const { rowCount } = await app.pool.query('DELETE FROM claude_session_groups WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'pasta não existe' });
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { group_id?: string | null } }>('/api/claude/sessions/:id/group', async (req, reply) => {
    const groupId = req.body?.group_id;
    if (groupId) {
      const { rowCount } = await app.pool.query('SELECT 1 FROM claude_session_groups WHERE id = $1', [groupId]);
      if (!rowCount) return reply.code(404).send({ error: 'pasta não existe' });
    }
    const { rowCount } = await app.pool.query('UPDATE claude_sessions SET group_id = $2 WHERE id = $1', [req.params.id, groupId || null]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    return { ok: true };
  });

  app.get('/api/claude/sessions', async (req) => {
    const { rows } = await app.pool.query(
      `SELECT s.id, s.title, s.status, s.input_tokens, s.output_tokens, s.turns, s.model, s.permission_mode, s.effort, s.cwd, s.last_error, s.archived, s.pinned, s.group_id, s.private, s.created_at, s.updated_at,
              u.id AS user_id, u.name AS user_name, p.slug AS project_slug, p.name AS project_name
         FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY s.updated_at DESC LIMIT 200`);
    // Sessão privada: só quem criou e o owner (admin) veem; some da lista pros outros (pedido do
    // Danilo, 09/10/2026 — ex.: tudo que o Gustavo fizer, só o Danilo vê).
    const visiveis = rows.filter(r => !r.private || r.user_id === req.user!.id || req.user!.role === 'owner');
    const sessions = visiveis.map(r => ({ ...r, status: motor.status(r.id) === 'idle' && r.status === 'error' ? 'error' : motor.status(r.id), pending: motor.pendentes(r.id).length }));
    // motor: 'offline' = runner reiniciando (modo socket); o front mostra a faixa "Motor de sessões reiniciando".
    return { sessions, motor: motor.online() ? 'online' : 'offline' };
  });

  // Busca dentro do conteúdo das mensagens (não só título): devolve os ids de sessão que têm
  // alguma mensagem de usuário/assistente (não de subagente) batendo com o termo. payload->'message'->>'content'
  // funciona tanto pro conteúdo string (user simples) quanto pro array de blocos (text/thinking/tool_use),
  // porque ->> converte o valor pra texto de qualquer jeito; casa também dentro de tool_use, o que é aceitável
  // aqui (achar "conversei sobre X" não precisa separar texto de ferramenta).
  app.get<{ Querystring: { q?: string } }>('/api/claude/sessions/search', async (req) => {
    const term = (req.query.q ?? '').trim();
    if (!term) return { sessionIds: [] };
    const escaped = term.replace(/[\\%_]/g, c => `\\${c}`);
    const { rows } = await app.pool.query(
      `SELECT DISTINCT session_id FROM claude_events
         WHERE type IN ('user', 'assistant') AND payload->>'parent_tool_use_id' IS NULL
           AND payload->'message'->>'content' ILIKE $1
         LIMIT 500`, [`%${escaped}%`]);
    return { sessionIds: rows.map(r => r.session_id as string) };
  });

  app.post<{ Params: { id: string }; Body: { pinned?: boolean } }>('/api/claude/sessions/:id/pin', async (req, reply) => {
    const pinned = !!req.body?.pinned;
    const { rowCount } = await app.pool.query('UPDATE claude_sessions SET pinned = $2 WHERE id = $1', [req.params.id, pinned]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    return { ok: true, pinned };
  });

  app.post<{ Params: { id: string }; Body: { private?: boolean } }>('/api/claude/sessions/:id/private', async (req, reply) => {
    const { rows } = await app.pool.query('SELECT user_id FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'sessão não existe' });
    if (rows[0].user_id !== req.user!.id && req.user!.role !== 'owner') return reply.code(403).send({ error: 'só quem criou ou o admin' });
    const priv = !!req.body?.private;
    await app.pool.query('UPDATE claude_sessions SET private = $2 WHERE id = $1', [req.params.id, priv]);
    return { ok: true, private: priv };
  });

  // Já busca o uso real ao subir, pra primeira tela depois de um deploy não esperar ~1s.
  void fetchRealUsage(app.pool).catch(() => {});

  app.get('/api/claude/usage', async () => {
    const { rows } = await app.pool.query(
      `SELECT u.id, u.name,
              COALESCE(SUM(s.input_tokens + s.output_tokens) FILTER (WHERE s.updated_at > now() - interval '5 hours'), 0) AS tokens_5h,
              COALESCE(SUM(s.input_tokens + s.output_tokens) FILTER (WHERE s.updated_at > now() - interval '7 days'), 0) AS tokens_7d,
              COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS tokens_total, COUNT(s.id) AS sessions
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
    // "% do uso" por modelo (breakdown de atribuição da tela Conta e Uso — string real "% of usage",
    // classes attribution*_QET5Ow; ver PARIDADE-seletor.md): tokens por modelo dos últimos 7 dias, da
    // coluna `claude_sessions.model` que o Orion já tem. O % é calculado no cliente
    // (computeModelAttribution em web/src/claude/mapper.ts), que também agrupa ids de modelo
    // diferentes sob o mesmo rótulo (ex.: claude-sonnet-* → "Sonnet").
    const { rows: byModel } = await app.pool.query(
      `SELECT model, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM claude_sessions
        WHERE updated_at > now() - interval '7 days'
        GROUP BY model`);
    return { usage: rows, real, by_model: byModel };
  });

  /** Rascunhos da caixa de mensagem da pessoa logada, por sessão (autosave). */
  app.get('/api/claude/drafts', async (req) => {
    const { rows } = await app.pool.query<{ session_id: string; text: string; attachments: unknown[] }>('SELECT session_id, text, attachments FROM claude_drafts WHERE user_id = $1', [req.user!.id]);
    return { drafts: Object.fromEntries(rows.map(r => [r.session_id, { text: r.text, attachments: r.attachments ?? [] }])) };
  });
  app.put<{ Params: { id: string }; Body: { text?: string; attachments?: Attachment[] } }>('/api/claude/drafts/:id', async (req, reply) => {
    const text = String(req.body?.text ?? '').slice(0, 200_000);
    // Só aceita anexos que já estão na pasta de uploads desta pessoa (nunca um caminho qualquer).
    const mine = path.join(uploadRoot, String(req.user!.id)) + path.sep;
    const atts = (Array.isArray(req.body?.attachments) ? req.body!.attachments : [])
      .filter(a => a && typeof a.path === 'string' && path.resolve(a.path).startsWith(mine))
      .slice(0, 20)
      .map(a => ({ kind: a.kind === 'image' ? 'image' : 'file', media_type: String(a.media_type ?? ''), name: String(a.name ?? 'arquivo'), path: path.resolve(a.path), size: Number((a as { size?: number }).size) || undefined }));
    if (!text.trim() && !atts.length) {
      await app.pool.query('DELETE FROM claude_drafts WHERE user_id = $1 AND session_id = $2', [req.user!.id, req.params.id]);
      return { ok: true };
    }
    const { rowCount } = await app.pool.query('SELECT 1 FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    await app.pool.query(
      `INSERT INTO claude_drafts (user_id, session_id, text, attachments) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, session_id) DO UPDATE SET text = EXCLUDED.text, attachments = EXCLUDED.attachments, updated_at = now()`, [req.user!.id, req.params.id, text, JSON.stringify(atts)]);
    return { ok: true };
  });

  /** Ditado: recebe o áudio gravado na tela e devolve o texto (Groq, com o Whisper local de reserva). */
  app.post('/api/claude/transcribe', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'envie como multipart/form-data' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'sem áudio' });
    const buf = await part.toBuffer();
    if (part.file.truncated) return reply.code(413).send({ error: 'áudio grande demais' });
    if (buf.length < 800) return { text: '', engine: 'none' };
    try {
      return await transcribe(app.pool, new Blob([new Uint8Array(buf)], { type: part.mimetype || 'audio/webm' }), part.filename || 'audio.webm');
    } catch (e) {
      req.log.error({ err: (e as Error).message }, 'transcrição falhou nos dois motores');
      return reply.code(502).send({ error: 'não consegui transcrever agora' });
    }
  });

  // Ditado em pedaços (12/11/2026, subida de 27 KB/s do celular): o navegador manda o áudio ENQUANTO
  // grava (um pedaço a cada 3 s, 24 kbps) e, ao soltar o botão, falta só o último pedaço. Os pedaços
  // só vão daqui pro disco; a Groq recebe UMA chamada com o arquivo inteiro no /fim (mesmo custo de antes).
  const DITADO_ID = /^[a-z0-9]{6,40}$/;
  const DITADO_BYTES_MAX = 25 * 1024 * 1024;
  const extAudio = (nome?: string | null) => { const m = /\.(webm|m4a|ogg|mp4)$/i.exec(nome ?? ''); return (m?.[1] ?? 'webm').toLowerCase(); };
  const mimeAudio = (ext: string) => ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : ext === 'ogg' ? 'audio/ogg' : 'audio/webm';
  const ditadoPath = (userId: number, id: string, ext: string) => path.join(uploadRoot, String(userId), `ditado-${id}.${ext}`);
  app.post<{ Querystring: { id?: string; seq?: string } }>('/api/claude/transcribe/pedaco', async (req, reply) => {
    const id = req.query?.id ?? '';
    if (!DITADO_ID.test(id) || !Number.isInteger(Number(req.query?.seq))) return reply.code(400).send({ error: 'pedaço inválido' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'envie como multipart/form-data' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'sem áudio' });
    const buf = await part.toBuffer();
    const dest = ditadoPath(req.user!.id, id, extAudio(part.filename));
    await mkdir(path.dirname(dest), { recursive: true });
    const atual = await stat(dest).then(st => st.size).catch(() => 0);
    if (atual + buf.length > DITADO_BYTES_MAX) return reply.code(413).send({ error: 'áudio grande demais' });
    await appendFile(dest, buf);
    return { ok: true, bytes: atual + buf.length };
  });
  app.post<{ Body: { id?: string; filename?: string } }>('/api/claude/transcribe/fim', async (req, reply) => {
    const id = req.body?.id ?? '';
    if (!DITADO_ID.test(id)) return reply.code(400).send({ error: 'gravação inválida' });
    const ext = extAudio(req.body?.filename);
    const dest = ditadoPath(req.user!.id, id, ext);
    const buf = await readFile(dest).catch(() => null);
    void unlink(dest).catch(() => {});
    if (!buf) return reply.code(404).send({ error: 'gravação não encontrada' });
    if (buf.length < 800) return { text: '', engine: 'none' };
    try {
      return await transcribe(app.pool, new Blob([new Uint8Array(buf)], { type: mimeAudio(ext) }), `ditado.${ext}`);
    } catch (e) {
      req.log.error({ err: (e as Error).message }, 'transcrição (pedaços) falhou nos dois motores');
      return reply.code(502).send({ error: 'não consegui transcrever agora' });
    }
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

  /**
   * Serve de volta um anexo de imagem já enviado — alimenta a miniatura clicável do histórico
   * (`Attachments` em Timeline.tsx, via `attachmentImageUrl` em web/src/claude/mapper.ts) e o popup
   * de imagem (`Lightbox.tsx`), 28/09/2026, pedido ao vivo do Bayerl pra copiar a UI/regra do popup
   * de imagem da extensão real — ver PARIDADE.md. O arquivo já existe no servidor desde o upload
   * (rota acima); nunca é apagado depois de usado num turno, então isso funciona mesmo pra sessões
   * antigas (desde que o anexo tenha sido enviado depois desta rodada, com `path` persistido — ver
   * runner.ts). `type` restrito à lista real de mídia de imagem que o SDK aceita
   * (`IMAGE_MEDIA_TYPES`, mesma constante que `attachmentBlocks` usa pra montar o bloco `image` do
   * turno) — nunca reflete um Content-Type arbitrário vindo da query. `path` validado com a MESMA
   * checagem de `sanitizeAttachments` (`isUnderRoot`, acima) — path traversal continua impossível.
   */
  app.get<{ Querystring: { path?: string; type?: string } }>('/api/claude/attachments', async (req, reply) => {
    const p = req.query?.path ?? '';
    const type = req.query?.type ?? '';
    // Imagem (miniatura) ou texto puro (ver o anexo colado); nunca text/html, que o navegador executaria.
    const texto = type === 'text/plain';
    if (!p || !((IMAGE_MEDIA_TYPES as readonly string[]).includes(type) || texto)) return reply.code(400).send({ error: 'parâmetros inválidos' });
    let rootReal: string;
    try { rootReal = await realpath(uploadRoot); } catch { rootReal = uploadRoot; }
    let rp: string;
    try { rp = await realpath(p); } catch { return reply.code(404).send({ error: 'não encontrado' }); }
    if (!isUnderRoot(rp, rootReal)) return reply.code(403).send({ error: 'acesso negado' });
    reply.header('Content-Type', texto ? 'text/plain; charset=utf-8' : type);
    reply.header('X-Content-Type-Options', 'nosniff');
    // Imutável: o nome do arquivo é um uuid novo por upload (nunca reescrito no mesmo caminho) — cache longo é seguro.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(createReadStream(rp));
  });

  // Autocompletar "@arquivo" no compositor: arquivos da pasta da sessão (ou da raiz do projeto, no rascunho).
  app.get<{ Querystring: { session?: string; project?: string; q?: string } }>('/api/claude/files', async (req) => {
    const { session, project, q = '' } = req.query ?? {};
    let cwd: string | undefined;
    if (session && !session.startsWith('draft-')) cwd = (await app.pool.query('SELECT cwd FROM claude_sessions WHERE id = $1', [session])).rows[0]?.cwd;
    else if (project && /^\d+$/.test(project)) cwd = (await app.pool.query('SELECT path FROM projects WHERE id = $1', [Number(project)])).rows[0]?.path;
    if (!cwd) return { files: [] };
    return { files: rankearArquivos(await arquivosDoProjeto(cwd), String(q).slice(0, 200)) };
  });

  app.post<{ Body: NewBody }>('/api/claude/sessions', async (req, reply) => {
    const b = req.body ?? {};
    const prompt = (b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt vazio' });
    // Sem project_id = sessão neutra: pasta própria fora de qualquer repositório, sem memória de projeto.
    let project: { id: number | null; name: string | null; path: string; rules: string | null };
    if (b.project_id == null) {
      await mkdir(neutroDir, { recursive: true });
      project = { id: null, name: null, path: neutroDir, rules: null };
    } else {
      const { rows: prow } = await app.pool.query('SELECT id, name, path, rules FROM projects WHERE id = $1', [b.project_id]);
      if (!prow[0]) return reply.code(400).send({ error: 'projeto não existe' });
      project = prow[0];
    }
    const d = await defaults();
    const mode = MODES.has(b.permission_mode ?? '') ? (b.permission_mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : (MODES.has(d.mode ?? '') ? (d.mode as 'default' | 'acceptEdits' | 'plan' | 'auto') : 'acceptEdits');
    // Valor de fio (pode ser 'ultracode'): persistido como está; montarTurno traduz pro SDK.
    // Padrão do sistema (Danilo, 04/10/2026): toda sessão nasce Sonnet Médio.
    const effort = EFFORTS.has(b.effort ?? '') ? b.effort : 'medium';
    const attachments = await sanitizeAttachments(b.attachments);
    if (attachments === null) return reply.code(400).send({ error: 'anexo inválido' });
    // Worktree escolhida no compositor: a sessão nasce nela (branch feature/<nome>), e cada turno
    // sobe para a raiz pela integração automática (spec 2026-09-30-preview-design, Parte 2).
    const proj = await projetoIntegracao(app.pool, project.id);
    let cwd: string = project.path;
    let avisoPasta: string | null = null;
    if (b.worktree_name && project.id != null) {
      const wt = await createWorktreeForProject(project.path, b.worktree_name, proj?.default_branch ?? 'main');
      if (!wt.ok) return reply.code(400).send({ error: wt.error });
      cwd = wt.path;
    } else if (project.id != null) {
      // Worktree por usuário (decisão 01/10/2026): a sessão nasce na worktree fixa da pessoa no projeto.
      const wt = await worktreeDoUsuario(project.path, slugPessoa(req.user!.name));
      if (wt.ok) cwd = wt.path;
      else avisoPasta = `Sessão na raiz do projeto, sem worktree própria: ${wt.motivo}. Mudanças aqui valem direto para todo mundo.`;
    }
    const id = randomUUID();
    // Sessões novas já nascem privadas se a pessoa tem esse padrão ligado (config do admin — ex.:
    // tudo que o Gustavo fizer, só o Danilo vê).
    const { rows: priv } = await app.pool.query('SELECT sessions_private_default FROM users WHERE id = $1', [req.user!.id]);
    await app.pool.query(
      `INSERT INTO claude_sessions (id, user_id, project_id, title, cwd, model, permission_mode, effort, status, private) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9)`,
      [id, req.user!.id, project.id, titleFromPrompt(prompt), cwd, b.model || d.model || 'sonnet', mode, effort, !!priv[0]?.sessions_private_default]);
    // Troca o título provisório (1ª linha do prompt) por um curto do Haiku; só se ninguém renomeou antes.
    void getSetting(app.pool, KEYS.claudeToken).then(tk => tituloCurto(prompt, tk)).then(async t => { if (t)
      await app.pool.query('UPDATE claude_sessions SET title = $2 WHERE id = $1 AND title = $3', [id, t, titleFromPrompt(prompt)]); }).catch(() => {});
    // Mesmo caminho da mensagem nova e da retomada (montarTurno lê a linha recém-inserida), só que isNew: true.
    await motor.iniciarTurno({ sessionId: id, userId: req.user!.id, prompt: buildPrompt(req.user!.name, prompt, attachments), mode, model: b.model || d.model || 'sonnet', effort, isNew: true, avisoPasta });
    return { id, title: titleFromPrompt(prompt) };
  });

  // POST /vista: a aba ativa recebeu turn_end, então a pessoa viu o turno terminar (claude/fora.ts).
  app.post<{ Params: { id: string } }>('/api/claude/sessions/:id/vista', async (req, reply) => {
    const { rowCount } = await app.pool.query('SELECT 1 FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    await marcarVista(app.pool, req.params.id, req.user!.id);
    return { ok: true };
  });

  // GET /fora: polling do front enquanto o resumo "Enquanto você estava fora" é gerado em segundo plano. Só leitura.
  app.get<{ Params: { id: string } }>('/api/claude/sessions/:id/fora', async (req) => cacheFora(app.pool, req.params.id, req.user!.id));

  // ?abrindo=1: o front está abrindo a sessão de fato (não reconexão do SSE, não script). Só aí
  // conta como "vista" e só aí o resumo "Enquanto você estava fora" pode chamar o modelo.
  app.get<{ Params: { id: string }; Querystring: { turnos?: string; abrindo?: string } }>('/api/claude/sessions/:id', async (req, reply) => {
    const { rows } = await app.pool.query(
      `SELECT s.*, u.name AS user_name, p.name AS project_name, p.slug AS project_slug FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = $1`, [req.params.id]);
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'sessão não existe' });
    await desarquivar(app.pool, s.id).catch(() => 0); // sessão antiga: eventos voltam do arquivo (tools/leveza.ts)
    const t = Number(req.query?.turnos);
    const turnos = Number.isInteger(t) && t > 0 ? Math.min(t, 100000) : 1000000;
    // Histórico enxuto: o SDK repete a lista inteira de comandos (`commands_changed`, ~350 KB) e o
    // `init` a cada turno, e isso era ~95% do peso (sessões de 80 a 120 MB, carga lenta no F5). A tela
    // só usa o PRIMEIRO init (linha "Sessão iniciada") e a lista de comandos mais recente.
    const { rows: events } = await app.pool.query(
      `WITH lim AS (
         SELECT max(seq) FILTER (WHERE payload->>'subtype' = 'commands_changed') AS last_cmd,
                min(seq) FILTER (WHERE payload->>'subtype' = 'init') AS first_init
           FROM claude_events WHERE session_id = $1 AND type = 'system'),
       -- ?turnos=N: só a partir do N-ésimo prompt mais recente (celular abre conversa longa rápido).
       corte AS (SELECT COALESCE((SELECT seq FROM claude_events WHERE session_id = $1 AND type = 'user_prompt' ORDER BY seq DESC OFFSET $2::int - 1 LIMIT 1), 0) AS seq),
       -- Orçamento em bytes (26/11/2026): os $3 bytes mais recentes voltam intactos (prints incluídos); o que vier antes
       -- disso, qualquer linha de usuário acima de 4 KB (sessão de agente tem milhares de ~27 KB) volta com cada tool_result trocado por uma nota (tool_use_id fica,
       -- pro bloco da ferramenta casar). Por TURNO não servia: uma sessão de agente tem 7.500 eventos e 212 MB em 3 turnos.
       -- O corte é AQUI, no Postgres: carregar isso no Node pra cortar depois estourava o heap (8 quedas num dia).
       -- tool_use_result (cópia inteira do resultado) vira só os 4 campos do mapa de agentes.
       base AS (
         SELECT e.seq, e.ts, e.type, e.payload, pg_column_size(e.payload) AS bytes,
                sum(pg_column_size(e.payload)) OVER (ORDER BY e.seq DESC) AS acumulado
           FROM claude_events e, lim, corte
          WHERE e.session_id = $1
            AND (e.seq >= corte.seq OR e.seq = lim.first_init)
            AND NOT (e.type = 'system' AND e.payload->>'subtype' = 'commands_changed' AND e.seq < lim.last_cmd)
            AND NOT (e.type = 'system' AND e.payload->>'subtype' = 'init' AND e.seq > lim.first_init))
       SELECT e.seq, e.ts, e.type,
         CASE WHEN e.type = 'user' THEN
           (CASE WHEN e.acumulado > $3::bigint AND e.bytes > 4096 AND jsonb_typeof(e.payload->'message'->'content') = 'array'
                 THEN jsonb_set(e.payload - 'tool_use_result', '{message,content}', COALESCE((
                        SELECT jsonb_agg(CASE WHEN b->>'type' = 'tool_result'
                          THEN jsonb_set(b, '{content}', to_jsonb('[saída grande de um trecho antigo não carregada (' || (pg_column_size(b) / 1024)::text || ' KB): a sessão viu na hora]'::text))
                          ELSE b END)
                        FROM jsonb_array_elements(e.payload->'message'->'content') b), '[]'::jsonb))
                 ELSE e.payload - 'tool_use_result' END)
           || COALESCE((SELECT jsonb_build_object('tool_use_result', jsonb_strip_nulls(jsonb_build_object(
                  'status', t->'status', 'totalTokens', t->'totalTokens', 'totalToolUseCount', t->'totalToolUseCount', 'totalDurationMs', t->'totalDurationMs')))
                FROM (SELECT e.payload->'tool_use_result' AS t) x WHERE jsonb_typeof(t) = 'object' AND t ? 'status'), '{}'::jsonb)
         WHEN e.type = 'system' THEN e.payload - 'workflow_progress'
         ELSE e.payload END AS payload
       FROM base e
       ORDER BY e.seq`, [s.id, turnos, SESSAO_BYTES_INTACTOS]);
    // Corte de 20 KB também na LEITURA (23/11/2026): sessão de agente com 20 turnos devolvia 50 MB de JSON
    // (tool_results gravados antes do corte de 12/11); abrir a sessão levava 18 s no p90, 193 s no pior caso.
    // Prints de ferramenta (base64) só nos 3 turnos mais recentes: eram 63 MB de 155 numa sessão de agente.
    // O grosso já veio cortado do Postgres (CTE img acima); aqui só o que sobrou pequeno: texto > 20 KB e imagem em linha ≤ 64 KB.
    for (const e of events) e.payload = truncarToolResult(e.payload);
    const abrindo = req.query?.abrindo === '1';
    // Lê o visto_em ANTES de marcar a vista: é a partir dele que se sabe o que a pessoa não viu.
    const fora = await foraDaSessao(app.pool, s.id, req.user!.id, { gerar: abrindo, token: () => getSetting(app.pool, KEYS.claudeToken) }).catch(() => null);
    if (abrindo) await marcarVista(app.pool, s.id, req.user!.id).catch(() => {});
    const primeiro = events.find(e => e.type === 'user_prompt')?.seq;
    const escondidos = turnos < 1000000 && primeiro !== undefined
      ? Number((await app.pool.query(`SELECT count(*) FROM claude_events WHERE session_id = $1 AND type = 'user_prompt' AND seq < $2`, [s.id, primeiro])).rows[0].count)
      : 0;
    return { session: { ...s, status: motor.status(s.id) === 'idle' ? s.status : motor.status(s.id) }, events, pending: motor.pendentes(s.id), hidden_turns: escondidos, fora };
  });

  app.get<{ Params: { id: string } }>('/api/claude/sessions/:id/stream', async (req, reply) => {
    const id = req.params.id;
    const { rowCount } = await app.pool.query('SELECT 1 FROM claude_sessions WHERE id = $1', [id]);
    if (!rowCount) return reply.code(404).send({ error: 'sessão não existe' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Backpressure (26/11/2026): o painel caiu 8x num dia por heap. Cada evento da sessão ia pra TODAS as abas
    // abertas nela (4 a 6), com o resultado da ferramenta em dobro (tool_use_result) e prints de 551 KB; uma aba
    // que não drena (celular dormindo, rede lenta) acumulava tudo no heap do Node sem teto. Agora: o que vai ao
    // vivo é o mesmo recorte do GET (sem a cópia), e aba com mais de SSE_BUFFER_MAX pendente é derrubada —
    // o EventSource reconecta sozinho e recarrega pelo GET (ver ClaudePage.tsx onopen).
    const send = (e: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if ((res.socket?.writableLength ?? 0) > SSE_BUFFER_MAX) { res.destroy(); return; }
      const ev = (e as { type?: string }).type === 'message' ? { ...(e as object), message: semWorkflowProgress(enxugarToolUseResult((e as { message: unknown }).message)) } : e;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    send({ type: 'hello', status: motor.status(id), pending: motor.pendentes(id), commands: await motor.comandos(id).catch(() => []) });
    const unsub = motor.assinar(id, send);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    sseAbertos.add(res);
    req.raw.on('close', () => { clearInterval(hb); unsub(); sseAbertos.delete(res); });
  });

  app.post<{ Params: { id: string }; Body: { prompt?: string; permission_mode?: string; model?: string; effort?: string; attachments?: Attachment[] } }>('/api/claude/sessions/:id/messages', async (req, reply) => {
    const prompt = (req.body?.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt vazio' });
    const attachments = await sanitizeAttachments(req.body?.attachments);
    if (attachments === null) return reply.code(400).send({ error: 'anexo inválido' });
    const { rows } = await app.pool.query(
      'SELECT s.id, s.cwd, s.model, s.permission_mode, s.effort, s.output_style, s.project_id, s.user_id, p.name AS project_name, p.rules, u.name AS creator FROM claude_sessions s LEFT JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.user_id WHERE s.id = $1', [req.params.id]);
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
    // Troca de esforço no meio da sessão: mesmo padrão do modelo acima (coluna nullable, sem
    // resolução automática por SDK) — só grava quando veio um valor válido e é diferente do já
    // persistido. Sem override, segue com s.effort (pode ser null: sessão sem esforço explícito
    // ainda, mesma semântica de "sem override" que model já tinha).
    const effortOverride = EFFORTS.has(req.body?.effort ?? '') ? req.body!.effort : undefined;
    if (effortOverride && effortOverride !== s.effort) await app.pool.query('UPDATE claude_sessions SET effort = $2 WHERE id = $1', [s.id, effortOverride]);
    const effort = effortOverride || s.effort || undefined;
    const { queued } = await motor.iniciarTurno({ sessionId: s.id, userId: req.user!.id, prompt: buildPrompt(req.user!.name, prompt, attachments), mode, model, effort, isNew: false });
    return { ok: true, queued };
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
    try { live = await motor.aoVivo(req.params.id, 'mode', mode); }
    catch (e: any) { if (e instanceof MotorIndisponivel) throw e; app.log.warn(`setPermissionMode ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
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
    try { live = await motor.aoVivo(req.params.id, 'model', model || undefined); }
    catch (e: any) { if (e instanceof MotorIndisponivel) throw e; app.log.warn(`setModel ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
  });

  /**
   * Troca de esforço AO VIVO (mid-turno) + persistência — trazida a paridade com modo/modelo nesta
   * rodada de follow-up (28/09/2026, pedido explícito do Bayerl depois da rodada 4/seção 8 do
   * PARIDADE.md, que só tinha implementado o lado ao vivo). Até aqui `effort` nunca era persistido
   * por sessão no Postgres — só reenviado em cada create/send (ver EFFORTS acima) — e o seletor
   * resetava pra 'medium' em todo reload/troca de aba, porque `ClaudePage.tsx` só guardava um
   * `useState` local sem equivalente na sessão salva (diferente de `permission_mode`/`model`, que já
   * tinham coluna própria e eram restaurados no efeito de carga da sessão).
   *
   * Mesmo padrão condicional já usado pela rota de modo/modelo logo acima: persiste no Postgres
   * PRIMEIRO (só grava quando o valor muda — coluna `claude_sessions.effort`, migração
   * `009_claude_effort`, nullable como `model`) — garante que o PRÓXIMO turno já nasce certo mesmo
   * sem Query viva agora — e SÓ DEPOIS tenta a aplicação ao vivo via `Runner.setEffortLive` (control
   * method `Query.applyFlagSettings({effortLevel})` do SDK), isolada em try/catch: uma falha nela
   * (rede, processo) nunca deve impedir a persistência, que já aconteceu antes; só um `app.log.warn`.
   */
  app.post<{ Params: { id: string }; Body: { effort?: string } }>('/api/claude/sessions/:id/effort', async (req, reply) => {
    const effort = req.body?.effort;
    if (!EFFORTS.has(effort ?? '')) return reply.code(400).send({ error: 'esforço inválido' });
    const { rows } = await app.pool.query('SELECT effort FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'sessão não existe' });
    if (effort !== rows[0].effort) await app.pool.query('UPDATE claude_sessions SET effort = $2 WHERE id = $1', [req.params.id, effort]);
    let live = false;
    // 'ultracode' ao vivo: o SDK só aceita os 5 níveis reais — resolveUltracode traduz pra xhigh
    // agora; a instrução de orquestração (systemAppend) só entra no PRÓXIMO turno, porque o system
    // prompt de um turno já em andamento não pode ser trocado no meio (simplificação documentada
    // em PARIDADE-seletor.md — a extensão real aplica a flag dela pelo mesmo canal de settings).
    try { live = await motor.aoVivo(req.params.id, 'effort', resolveUltracode(effort).effort); }
    catch (e: any) { if (e instanceof MotorIndisponivel) throw e; app.log.warn(`setEffort ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
  });

  /**
   * Troca de output style por sessão — o menu "Output styles" da extensão real (ver
   * server/tools/outputStyles.ts pra investigação completa e PARIDADE-marketplace.md). Mesmo
   * contrato das irmãs de modo/modelo/esforço acima: valida contra a lista real de estilos
   * (embutidos + catálogo), persiste no Postgres PRIMEIRO (coluna claude_sessions.output_style,
   * nullable; 'default' vira null = sem estilo) e SÓ DEPOIS tenta a aplicação ao vivo via
   * `Runner.setOutputStyleLive` (`Query.applyFlagSettings({outputStyle})`), isolada em try/catch.
   * O turno seguinte nasce certo de qualquer forma: montarTurno manda o valor persistido pro SDK pela
   * camada de settings de flag (`Options.settings.outputStyle` — ver TurnParams em runner.ts).
   */
  app.post<{ Params: { id: string }; Body: { style?: string } }>('/api/claude/sessions/:id/output-style', async (req, reply) => {
    const bruto = (req.body?.style ?? '').trim();
    const style = bruto && bruto !== 'default' ? bruto : null;
    if (style && !(await estiloConhecido(style))) return reply.code(400).send({ error: 'estilo desconhecido' });
    const { rows } = await app.pool.query('SELECT output_style FROM claude_sessions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'sessão não existe' });
    if (style !== rows[0].output_style) await app.pool.query('UPDATE claude_sessions SET output_style = $2 WHERE id = $1', [req.params.id, style]);
    let live = false;
    try { live = await motor.aoVivo(req.params.id, 'outputStyle', style); }
    catch (e: any) { if (e instanceof MotorIndisponivel) throw e; app.log.warn(`setOutputStyle ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
  });

  app.post<{ Params: { id: string }; Body: { approval_id?: string; decision?: string; message?: string } }>('/api/claude/sessions/:id/permission', async (req, reply) => {
    const d = req.body?.decision;
    if (d !== 'allow' && d !== 'allow_always' && d !== 'deny' && d !== 'answer') return reply.code(400).send({ error: 'decisão inválida' });
    const ok = await motor.decidir(req.params.id, req.body?.approval_id ?? '', d, req.user!.id, req.body?.message);
    if (!ok) return reply.code(404).send({ error: 'pedido de permissão não está pendente' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/claude/sessions/:id/stop', async (req) => {
    await motor.parar(req.params.id);
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
    await motor.parar(req.params.id);
    await app.pool.query('DELETE FROM claude_sessions WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  /** Opções do card do projeto (Dash › Projetos): conectores claude.ai que a conta tem e contas GitHub cadastradas. */
  app.get('/api/claude/leveza/opcoes', async () => ({
    conectores: await listarConectoresClaudeAi(app.pool),
    contas: (await listarContasGithub(app.pool)).map(c => ({ id: c.id, label: c.label, login: c.login })),
  }));
}
