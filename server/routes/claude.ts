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
import { access, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Runner, IMAGE_MEDIA_TYPES, type Attachment, type TurnPrompt } from '../claude/runner.js';
import { pgStore } from '../claude/store.js';
import { tituloCurto } from '../claude/titulo.js';
import { buildSystemAppend, prefixPrompt, titleFromPrompt, REGRAS_MAX, DECISOES_MAX, type MemoriaDecisao, type MemoriaRegra } from '../claude/header.js';
import { orionMemoryServer } from '../claude/memoryTool.js';
import { orionRootServer } from '../claude/rootTool.js';
import { composicaoPara } from '../tools/skillPrefs.js';
import { estiloConhecido } from '../tools/outputStyles.js';
import { KEYS, ensureSettingsTable, getSetting, hostingerMcpServers, sdkEnv } from '../settings.js';
import { backupAntes, dbUrlKey } from '../dbBackup.js';
import { FilaIntegracao } from '../integracao/fila.js';
import { ganchosDaSessao } from '../integracao/turno.js';
import { createWorktreeForProject, worktreeDoUsuario } from '../claude/worktree.js';
import { branchAtual } from '../tasks/git.js';
import { slugPessoa } from '../preview/model.js';
import type { BackupFn } from '../claude/policy.js';
import { ensureGithubAccountsTable, githubMcpServers, githubParaHeader, listarContasGithub } from '../tools/githubAccounts.js';
import { cloudflareParaHeader, ensureCloudflareAccountsTable, listarContasCloudflare } from '../tools/cloudflareAccounts.js';
import { cofreCdpUrl, cofreMcpServers, cofrePainelUrl, cofreParaHeader } from '../tools/cofre.js';
import { fetchRealUsage } from '../claude/realUsage.js';
import { ULTRACODE, resolveUltracode, withUltracodeAppend } from '../claude/ultracode.js';
import { safeFilename } from '../driveUtils.js';
import { lerStatus, tailDoLog, type Status } from '../deploy/estado.js';

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
const UPLOAD_MAX_FILES = 10;

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

export const RESUME_PROMPT = 'O servidor do Orion reiniciou no meio do seu turno (deploy ou queda) e ele foi cortado. Continue de onde parou. Se o reinício foi causado por você mesmo (ex.: systemctl restart orion-central), ele já aconteceu com sucesso: não reinicie de novo, só confira o resultado e siga.';

/** Início do aviso de publicação que deu certo. A Timeline procura este trecho (web/src/claude/mapper.ts,
 * DEPLOY_OK_MARCA) pra mostrar a ferramenta cortada como "interrompida pela publicação", não como erro. */
export const DEPLOY_OK_MARCA = 'Publicação do Orion: deu certo';

/**
 * O que a retomada conta sobre a publicação que causou o reinício. Só fala de build terminado há menos
 * de 10 min (ou ainda rodando); reinício por queda, sem deploy recente, não ganha nota nenhuma.
 */
export function notaDeploy(st: Status | null, now: Date, fimDoLog = ''): string {
  if (!st) return '';
  if (st.estado === 'fila' || st.estado === 'rodando') return `\n\nPublicação do Orion ainda em andamento (${st.etapa}). Confira /srv/builds/status.json antes de seguir.`;
  const fim = st.fim ? Date.parse(st.fim) : NaN;
  if (!Number.isFinite(fim) || now.getTime() - fim > 10 * 60_000) return '';
  if (st.estado === 'ok') return `\n\n${DEPLOY_OK_MARCA} (build ${st.nome}, commit ${st.sha} "${st.msg}"). Já está no ar: não espere nem publique de novo.`;
  return `\n\nPublicação do Orion FALHOU (${st.etapa}); a versão anterior (${st.anterior}) segue no ar. Log: ${st.log}${fimDoLog ? `\nFim do log:\n\`\`\`\n${fimDoLog}\n\`\`\`` : ''}`;
}

/** Mensagem gravada como evento 'error' (e last_error) quando o Orion desiste de retomar sozinho; a Timeline
 * casa o trecho "não retomado automaticamente" pra oferecer o botão "Continuar de onde parou". */
export const NAO_RETOMADA = `Turno cortado e não retomado automaticamente: já foram 3 retomadas seguidas sem uma mensagem de gente no meio (proteção contra loop). Clique em "Continuar de onde parou" ou mande uma mensagem.`;

/** Prompt do vigia quando o turno caiu com erro (SDK/API), sem reinício do servidor. */
export const VIGIA_PROMPT = (erro: string) => `O seu turno anterior caiu com erro: "${erro.slice(0, 300)}". Continue de onde parou. Se o erro se repetir igual, pare e explique o que está travando.`;

/** Retomada automática = prompt do Orion com "Continue de onde parou" (retomada pós-restart ou vigia). */
const ehRetomadaAuto = (prompt: string) => prompt.startsWith('[Orion] ') && prompt.includes('Continue de onde parou');

/**
 * Retoma sozinho? Sim, até 3 retomadas automáticas seguidas (nos últimos 30 min, sem mensagem de gente
 * no meio). Antes era "não retoma se a última retomada tem menos de 10 min", o que travava a sessão que
 * publica duas vezes em seguida (deploy ok não é loop). `recentes`: últimos user_prompt, mais novo primeiro.
 */
export function shouldResume(recentes: { prompt: string; ts: Date }[], now: Date): boolean {
  let seguidas = 0;
  for (const r of recentes) {
    if (!ehRetomadaAuto(r.prompt) || now.getTime() - r.ts.getTime() > 30 * 60_000) break;
    seguidas++;
  }
  return seguidas < 3;
}

type NewBody = { project_id?: number | null; prompt?: string; permission_mode?: string; model?: string; effort?: string; attachments?: Attachment[]; worktree_name?: string };

export async function claudeRoutes(app: FastifyInstance) {
  const store = pgStore(app.pool);
  const runner = new Runner({ queryFn: query, store, log: (m) => app.log.warn(m) });
  const filaIntegracao = new FilaIntegracao();
  app.decorate('runner', runner);
  await ensureSettingsTable(app.pool);
  // As tabelas de contas nascem aqui também: a retomada de sessões pós-restart roda antes das rotas de Tools.
  await ensureGithubAccountsTable(app.pool);
  await ensureCloudflareAccountsTable(app.pool);
  await app.pool.query('ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false');
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

  /** Backup antes de SQL destrutivo (policy.ts): só existe quando o projeto tem db_url configurado. */
  async function backupPara(projectId: number | null): Promise<BackupFn | undefined> {
    if (!projectId) return undefined;
    const dbUrl = await getSetting(app.pool, dbUrlKey(projectId));
    const { rows } = await app.pool.query('SELECT slug FROM projects WHERE id = $1', [projectId]);
    const slug: string | undefined = rows[0]?.slug;
    if (!dbUrl || !slug) return undefined;
    return (sql) => backupAntes({ dbUrl, slug, sql });
  }

  /** Projeto para a integração; a base é a branch em que a raiz está (o que o preview raiz mostra), não `main` fixo. */
  async function projetoIntegracao(projectId: number | null): Promise<{ id: number; path: string; default_branch: string } | null> {
    if (!projectId) return null;
    const { rows } = await app.pool.query('SELECT id, path FROM projects WHERE id = $1', [projectId]);
    if (!rows[0]) return null;
    return { id: rows[0].id, path: rows[0].path, default_branch: (await branchAtual(rows[0].path)) ?? 'main' };
  }

  /** Monta o prompt do turno: string simples quando não há anexos, senão { text, attachments }. */
  type SessionRow = { id: string; cwd: string; project_id: number | null; user_id?: number; project_name: string | null; rules: string | null; creator: string; output_style?: string | null };
  /** Dispara um turno numa sessão já existente (mensagem nova ou retomada pós-restart). */
  async function startFor(s: SessionRow, userId: number, prompt: TurnPrompt, mode: 'default' | 'acceptEdits' | 'plan' | 'auto', model?: string, effort?: string) {
    // A tool orion-memory recebe o contexto da SESSÃO (projeto + criador, s.user_id): é ele que
    // vira o escopo padrão do salvar. Skills e memórias do header seguem com quem pediu o turno.
    // `effort` chega no valor de fio (pode ser 'ultracode', vindo da rota ou da coluna persistida) —
    // resolveUltracode traduz pro SDK e liga a instrução de orquestração no systemAppend quando for o caso.
    const eff = resolveUltracode(effort);
    const textoPrompt = typeof prompt === 'string' ? prompt : prompt.text;
    // Duas sessões da mesma pessoa no projeto dividem a worktree dela: avisa quando a outra está rodando.
    const { rows: paralelas } = await app.pool.query<{ title: string }>(
      `SELECT title FROM claude_sessions WHERE cwd = $1 AND id <> $2 AND status = 'running' LIMIT 3`, [s.cwd, s.id]);
    if (paralelas.length) runner.aviso(s.id, `Atenção: ${paralelas.map(p => `"${p.title}"`).join(', ')} está rodando agora na mesma pasta. As duas sessões mexem nos mesmos arquivos.`);
    const ganchos = ganchosDaSessao({
      sessaoId: s.id, cwd: s.cwd, projeto: await projetoIntegracao(s.project_id ?? null), prompt: textoPrompt.replace(/^\[[^\]]+\]\s*/, ''), fila: filaIntegracao,
      avisar: (texto) => { void startFor(s, userId, prefixPrompt('Orion', texto), mode, model, effort); },
      registrar: (texto) => { runner.aviso(s.id, texto); },
    });
    runner.startTurn({
      sessionId: s.id, cwd: s.cwd, prompt, isNew: false, ganchos, permissionMode: mode, model, effort: eff.effort, outputStyle: s.output_style ?? undefined, env: await turnEnv(), mcpServers: await turnMcpServers(s.id, s.project_id ?? null, s.user_id ?? userId), ...(await composicaoPara(app.pool, userId)), taskBudgetTokens: (await defaults()).budget, backupSql: await backupPara(s.project_id ?? null),
      systemAppend: withUltracodeAppend(buildSystemAppend({ projectName: s.project_name ?? null, projectPath: s.cwd, createdBy: s.creator, rules: s.rules, ...(await memoriasPara(s.project_id ?? null, userId)), github: githubParaHeader(await listarContasGithub(app.pool)), cloudflare: cloudflareParaHeader(await listarContasCloudflare(app.pool)), cofre: cofreParaHeader(cofreCdpUrl(), cofrePainelUrl()) }), eff.ultracode),
    });
  }

  function buildPrompt(userName: string, prompt: string, attachments: Attachment[]): TurnPrompt {
    const text = prefixPrompt(userName, prompt);
    return attachments.length ? { text, attachments } : text;
  }
  const turnEnv = async () => sdkEnv(await getSetting(app.pool, KEYS.claudeToken));
  // MCPs de toda sessão: hostinger (quando há token) + um github por conta cadastrada na aba Tools + orion-memory (sempre).
  // Cloudflare não é MCP: é conector simples (proxy local /conector/<nome>), só entra no header.
  // Cofre (Chrome compartilhado da c3) entra como MCP `cofre` quando COFRE_CDP_URL está no ambiente.
  const turnMcpServers = async (sessionId: string, projectId: number | null, userId: number) => ({
    ...(hostingerMcpServers(await getSetting(app.pool, KEYS.hostingerToken)) ?? {}),
    ...githubMcpServers(await listarContasGithub(app.pool)),
    ...(cofreMcpServers(cofreCdpUrl()) ?? {}),
    'orion-memory': orionMemoryServer(app.pool, { sessionId, projectId, userId }),
    'orion-root': orionRootServer(sessionId),
  });
  const defaults = async () => ({ mode: await getSetting(app.pool, KEYS.defaultMode), model: await getSetting(app.pool, KEYS.defaultModel), budget: Number(await getSetting(app.pool, KEYS.taskBudgetTokens)) || undefined });

  // Memórias que entram no systemAppend, por nível (0/1 chegam pelo CLAUDE.md; 4 só pela tool):
  // nível 2 com corpo (universais + do projeto da sessão + do usuário criador), nível 3 só índice.
  async function memoriasPara(projectId: number | null, userId: number): Promise<{ regras: MemoriaRegra[]; decisoes: MemoriaDecisao[] }> {
    try {
      const { rows } = await app.pool.query(
        `SELECT level, code, title, summary, body_md, scope_project_id, scope_user_id FROM memories
          WHERE level IN (2, 3) AND (scope_project_id = $1 OR scope_user_id = $2 OR (scope_project_id IS NULL AND scope_user_id IS NULL))
          ORDER BY level ASC, updated_at DESC`, [projectId, userId]);
      const escopo = (r: any) => (r.scope_project_id ? 'projeto' : r.scope_user_id ? 'usuário' : 'universal') as MemoriaRegra['scope'];
      return {
        regras: rows.filter((r: any) => r.level === 2).slice(0, REGRAS_MAX)
          .map((r: any) => ({ title: r.title, body: r.body_md, scope: escopo(r) })),
        decisoes: rows.filter((r: any) => r.level === 3).slice(0, DECISOES_MAX)
          .map((r: any) => ({ code: r.code, title: r.title, summary: r.summary })),
      };
    } catch { return { regras: [], decisoes: [] }; }
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
    const { rows } = await app.pool.query('SELECT id, slug, name, path, rules FROM projects ORDER BY id');
    return { projects: rows };
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

  app.get('/api/claude/sessions', async () => {
    const { rows } = await app.pool.query(
      `SELECT s.id, s.title, s.status, s.input_tokens, s.output_tokens, s.turns, s.model, s.permission_mode, s.effort, s.cwd, s.last_error, s.archived, s.group_id, s.created_at, s.updated_at,
              u.id AS user_id, u.name AS user_name, p.slug AS project_slug, p.name AS project_name
         FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY s.updated_at DESC LIMIT 200`);
    const sessions = rows.map(r => ({ ...r, status: runner.status(r.id) === 'idle' && r.status === 'error' ? 'error' : runner.status(r.id), pending: runner.pendingPermissions(r.id).length }));
    return { sessions };
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
    if (!p || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(type)) return reply.code(400).send({ error: 'parâmetros inválidos' });
    let rootReal: string;
    try { rootReal = await realpath(uploadRoot); } catch { rootReal = uploadRoot; }
    let rp: string;
    try { rp = await realpath(p); } catch { return reply.code(404).send({ error: 'não encontrado' }); }
    if (!isUnderRoot(rp, rootReal)) return reply.code(403).send({ error: 'acesso negado' });
    reply.header('Content-Type', type);
    // Imutável: o nome do arquivo é um uuid novo por upload (nunca reescrito no mesmo caminho) — cache longo é seguro.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(createReadStream(rp));
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
    // Valor de fio (pode ser 'ultracode') — persistido como está; traduzido pro SDK logo abaixo.
    const effort = EFFORTS.has(b.effort ?? '') ? b.effort : undefined;
    const eff = resolveUltracode(effort);
    const attachments = await sanitizeAttachments(b.attachments);
    if (attachments === null) return reply.code(400).send({ error: 'anexo inválido' });
    // Worktree escolhida no compositor: a sessão nasce nela (branch feature/<nome>), e cada turno
    // sobe para a raiz pela integração automática (spec 2026-09-30-preview-design, Parte 2).
    const proj = await projetoIntegracao(project.id);
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
    await app.pool.query(
      `INSERT INTO claude_sessions (id, user_id, project_id, title, cwd, model, permission_mode, effort, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')`,
      [id, req.user!.id, project.id, titleFromPrompt(prompt), cwd, b.model || d.model || null, mode, effort ?? null]);
    // Troca o título provisório (1ª linha do prompt) por um curto do Haiku; só se ninguém renomeou antes.
    void getSetting(app.pool, KEYS.claudeToken).then(tk => tituloCurto(prompt, tk)).then(async t => { if (t)
      await app.pool.query('UPDATE claude_sessions SET title = $2 WHERE id = $1 AND title = $3', [id, t, titleFromPrompt(prompt)]); }).catch(() => {});
    if (avisoPasta) runner.aviso(id, avisoPasta);
    const sessaoNova = { id, cwd, project_id: project.id, user_id: req.user!.id, project_name: project.name, rules: project.rules, creator: req.user!.name };
    const ganchos = ganchosDaSessao({
      sessaoId: id, cwd, projeto: proj, prompt, fila: filaIntegracao,
      avisar: (texto) => { void startFor(sessaoNova, req.user!.id, prefixPrompt('Orion', texto), mode, b.model || d.model || undefined, effort); },
      registrar: (texto) => { runner.aviso(id, texto); },
    });
    runner.startTurn({
      sessionId: id, cwd, ganchos, prompt: buildPrompt(req.user!.name, prompt, attachments), isNew: true, permissionMode: mode, model: b.model || d.model || undefined, effort: eff.effort, env: await turnEnv(), mcpServers: await turnMcpServers(id, project.id, req.user!.id), ...(await composicaoPara(app.pool, req.user!.id)), taskBudgetTokens: d.budget, backupSql: await backupPara(project.id),
      systemAppend: withUltracodeAppend(buildSystemAppend({ projectName: project.name, projectPath: cwd, createdBy: req.user!.name, rules: project.rules, ...(await memoriasPara(project.id, req.user!.id)), github: githubParaHeader(await listarContasGithub(app.pool)), cloudflare: cloudflareParaHeader(await listarContasCloudflare(app.pool)), cofre: cofreParaHeader(cofreCdpUrl(), cofrePainelUrl()) }), eff.ultracode),
    });
    return { id, title: titleFromPrompt(prompt) };
  });

  app.get<{ Params: { id: string } }>('/api/claude/sessions/:id', async (req, reply) => {
    const { rows } = await app.pool.query(
      `SELECT s.*, u.name AS user_name, p.name AS project_name, p.slug AS project_slug FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = $1`, [req.params.id]);
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'sessão não existe' });
    // Histórico enxuto: o SDK repete a lista inteira de comandos (`commands_changed`, ~350 KB) e o
    // `init` a cada turno, e isso era ~95% do peso (sessões de 80 a 120 MB, carga lenta no F5). A tela
    // só usa o PRIMEIRO init (linha "Sessão iniciada") e a lista de comandos mais recente.
    const { rows: events } = await app.pool.query(
      `WITH lim AS (
         SELECT max(seq) FILTER (WHERE payload->>'subtype' = 'commands_changed') AS last_cmd,
                min(seq) FILTER (WHERE payload->>'subtype' = 'init') AS first_init
           FROM claude_events WHERE session_id = $1 AND type = 'system')
       SELECT e.seq, e.ts, e.type, e.payload FROM claude_events e, lim
        WHERE e.session_id = $1
          AND NOT (e.type = 'system' AND e.payload->>'subtype' = 'commands_changed' AND e.seq < lim.last_cmd)
          AND NOT (e.type = 'system' AND e.payload->>'subtype' = 'init' AND e.seq > lim.first_init)
        ORDER BY e.seq`, [s.id]);
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
    await startFor(s, req.user!.id, buildPrompt(req.user!.name, prompt, attachments), mode, model, effort);
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
    try { live = await runner.setEffortLive(req.params.id, resolveUltracode(effort).effort); }
    catch (e: any) { app.log.warn(`setEffort ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
    return { ok: true, live };
  });

  /**
   * Troca de output style por sessão — o menu "Output styles" da extensão real (ver
   * server/tools/outputStyles.ts pra investigação completa e PARIDADE-marketplace.md). Mesmo
   * contrato das irmãs de modo/modelo/esforço acima: valida contra a lista real de estilos
   * (embutidos + catálogo), persiste no Postgres PRIMEIRO (coluna claude_sessions.output_style,
   * nullable; 'default' vira null = sem estilo) e SÓ DEPOIS tenta a aplicação ao vivo via
   * `Runner.setOutputStyleLive` (`Query.applyFlagSettings({outputStyle})`), isolada em try/catch.
   * O turno seguinte nasce certo de qualquer forma: startFor manda o valor persistido pro SDK pela
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
    try { live = await runner.setOutputStyleLive(req.params.id, style); }
    catch (e: any) { app.log.warn(`setOutputStyle ao vivo falhou (sessão ${req.params.id}): ${e?.message ?? e}`); }
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

  // Colunas que startFor precisa + os últimos prompts (pra contar retomadas automáticas seguidas).
  const SESSAO_RETOMAVEL = `SELECT s.id, s.cwd, s.model, s.permission_mode, s.effort, s.output_style, s.project_id, s.user_id, s.last_error,
            p.name AS project_name, p.rules, u.name AS creator,
            (SELECT coalesce(json_agg(json_build_object('prompt', x.prompt, 'ts', x.ts)), '[]') FROM
               (SELECT e.payload->>'prompt' AS prompt, e.ts FROM claude_events e WHERE e.session_id = s.id AND e.type = 'user_prompt' ORDER BY e.seq DESC LIMIT 5) x) AS recentes
       FROM claude_sessions s LEFT JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.user_id`;

  /** Retoma a sessão com um prompt do Orion, ou desiste (evento 'error' visível + botão Continuar) depois de 3 seguidas. */
  async function retomar(s: any, prompt: string): Promise<void> {
    if (!shouldResume((s.recentes ?? []).map((r: any) => ({ prompt: r.prompt ?? '', ts: new Date(r.ts) })), new Date())) {
      await store.appendEvent(s.id, 'error', { message: NAO_RETOMADA }).catch(() => {});
      await app.pool.query("UPDATE claude_sessions SET status = 'error', last_error = $2 WHERE id = $1", [s.id, NAO_RETOMADA]).catch(() => {});
      return;
    }
    const mode = MODES.has(s.permission_mode) ? s.permission_mode : 'acceptEdits';
    await startFor(s, s.user_id, prefixPrompt('Orion', prompt), mode, s.model ?? undefined, s.effort ?? undefined);
  }

  // Turnos cortados por restart do servidor (deploy, crash): nada roda em memória depois do boot,
  // então retoma cada sessão que estava 'running'/'waiting' com um "continue" em nome do Orion, pra
  // ninguém precisar voltar lá e cutucar. O SDK retoma a conversa pelo id (resume).
  const { rows: cortadas } = await app.pool.query(`${SESSAO_RETOMAVEL} WHERE s.status IN ('running','waiting')`).catch(() => ({ rows: [] as any[] }));
  await app.pool.query("UPDATE claude_sessions SET status = 'idle' WHERE status IN ('running','waiting')").catch(() => {});
  // Fora do await do plugin: o boot não pode travar (o build.sh espera o /api/health responder). Se o
  // reinício veio de um deploy, o status.json ainda diz 'rodando' (o build só fecha 'ok' depois do health):
  // espera até 3 min o resultado final pra retomada já contar se deu certo. Se este processo morrer antes
  // (health falhou, rollback), quem retoma é o próximo boot, que verá o 'falhou'.
  if (cortadas.length) void (async () => {
    let st = await lerStatus().catch(() => null);
    for (let i = 0; i < 90 && (st?.estado === 'fila' || st?.estado === 'rodando'); i++) {
      await new Promise(r => setTimeout(r, 2000));
      st = await lerStatus().catch(() => null);
    }
    const nota = notaDeploy(st, new Date(), st?.estado === 'falhou' && st.log ? await tailDoLog(st.log, 30) : '');
    for (const s of cortadas) {
      if (runner.status(s.id) !== 'idle') continue; // alguém mandou mensagem enquanto esperávamos o deploy
      app.log.warn(`retomando sessão ${s.id} cortada por restart`);
      void retomar(s, RESUME_PROMPT + nota).catch(e => app.log.warn(`retomada de ${s.id} falhou: ${(e as Error).message}`));
    }
  })();

  // Vigia: turno que caiu com erro do SDK/API (sem reinício) fica parado em 'error' até alguém cutucar.
  // A cada 2 min, retoma quem caiu há 1-30 min com evento 'error' (nunca 'interrupted' = Parar manual,
  // nem result com erro = orçamento/limite de turnos, que param de propósito). Mesmo limite de 3 seguidas.
  // ponytail: varredura por intervalo; vira evento do runner quando o motor sair pro processo próprio.
  const vigia = setInterval(() => void (async () => {
    const { rows } = await app.pool.query(`${SESSAO_RETOMAVEL}
      WHERE s.status = 'error' AND s.archived IS NOT TRUE AND s.last_error IS DISTINCT FROM $1
        AND s.updated_at BETWEEN now() - interval '30 minutes' AND now() - interval '1 minute'
        AND (SELECT e.type FROM claude_events e WHERE e.session_id = s.id AND e.type IN ('error','interrupted','result','user_prompt') ORDER BY e.seq DESC LIMIT 1) = 'error'`, [NAO_RETOMADA]);
    for (const s of rows) {
      if (runner.status(s.id) === 'running' || runner.status(s.id) === 'waiting') continue;
      app.log.warn(`vigia: retomando sessão ${s.id} que caiu com erro`);
      await retomar(s, VIGIA_PROMPT(s.last_error ?? 'erro'));
    }
  })().catch(e => app.log.warn(`vigia falhou: ${(e as Error).message}`)), 2 * 60_000);
  app.addHook('onClose', async () => clearInterval(vigia));

}
