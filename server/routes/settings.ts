import type { FastifyInstance } from 'fastify';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { KEYS, deleteSetting, ensureSettingsTable, getSetting, looksLikeClaudeToken, maskToken, sdkEnv, setSetting } from '../settings.js';
import { LoginFlow } from '../claude/login.js';
import { readClaudeCredentials, credentialsPath } from '../claude/credentialsFile.js';
import { unlink } from 'node:fs/promises';

export async function settingsRoutes(app: FastifyInstance) {
  await ensureSettingsTable(app.pool);
  let flow: LoginFlow | null = null;
  const currentUser = { id: null as number | null };

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
  });

  app.get('/api/settings', async () => {
    const [token, mode, model, budget] = await Promise.all([
      getSetting(app.pool, KEYS.claudeToken), getSetting(app.pool, KEYS.defaultMode), getSetting(app.pool, KEYS.defaultModel), getSetting(app.pool, KEYS.maxBudgetUsd)]);
    // Duas formas de estar conectado: token estático (`claude setup-token`, salvo aqui no Postgres)
    // ou sessão do login normal (`claude auth login`, vive em ~/.claude/.credentials.json e se renova
    // sozinha — nunca copiada pra cá, ver claude/login.ts). Ambas fazem sdkEnv/turnEnv funcionarem.
    const fileCreds = token ? null : await readClaudeCredentials();
    const { rows } = await app.pool.query('SELECT key, updated_at, u.name AS updated_by FROM settings s LEFT JOIN users u ON u.id = s.updated_by');
    return {
      claude: {
        token_set: !!token || !!fileCreds,
        token_hint: maskToken(token),
        via: token ? 'token' : (fileCreds ? 'login' : null),
        linux_user: process.env.USER ?? null,
      },
      defaults: { permission_mode: mode ?? 'acceptEdits', model: model ?? '', max_budget_usd: budget ? Number(budget) : 5 },
      meta: rows,
    };
  });

  app.put<{ Body: { token?: string } }>('/api/settings/claude-token', async (req, reply) => {
    const token = (req.body?.token ?? '').trim();
    if (!looksLikeClaudeToken(token)) return reply.code(400).send({ error: 'isso não parece um token do `claude setup-token` (começa com sk-ant-)' });
    await setSetting(app.pool, KEYS.claudeToken, token, req.user!.id);
    return { ok: true, token_hint: maskToken(token) };
  });

  app.delete('/api/settings/claude-token', async (req) => {
    await deleteSetting(app.pool, KEYS.claudeToken);
    // Se a conexão ativa era via `claude auth login` (sem token no Postgres), desconectar precisa
    // também invalidar o arquivo de credenciais, senão sdkEnv(null) continuaria caindo nele.
    try { await unlink(credentialsPath()); } catch { /* não tinha arquivo (era conexão por token) — normal */ }
    app.log.info(`token do Claude removido por ${req.user!.email}`);
    return { ok: true };
  });

  /** Teste real e barato: uma pergunta, sem ferramentas, um turno. */
  app.post('/api/settings/claude-token/test', async () => {
    const token = await getSetting(app.pool, KEYS.claudeToken);
    const t0 = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 90_000);
    let model = '', text = '', cost = 0, error = '';
    try {
      const q = query({ prompt: 'Responda apenas com a palavra: ok', options: {
        cwd: '/tmp', maxTurns: 1, tools: [], permissionMode: 'default', settingSources: [], abortController: abort, env: sdkEnv(token),
        systemPrompt: 'Você é um teste de conexão. Responda só "ok".',
      } });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') model = m.model;
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') text += b.text;
        if (m.type === 'result') { cost = m.total_cost_usd ?? 0; if (m.is_error) error = (m as any).result ?? m.subtype; }
      }
    } catch (e: any) {
      error = String(e?.message ?? e);
    } finally { clearTimeout(timer); }
    return { ok: !error, model, reply: text.trim().slice(0, 200), cost_usd: cost, ms: Date.now() - t0, error: error || null, via: token ? 'token' : 'login do usuário linux' };
  });

  /** Login pelo navegador, igual ao plugin: a Central roda `claude auth login --claudeai` na c3 e faz
   * a ponte (ver claude/login.ts pro porquê da troca do `setup-token`). */
  app.post('/api/settings/claude-login/start', async (req) => {
    currentUser.id = req.user!.id;
    if (!flow || flow.state === 'done' || flow.state === 'error' || flow.state === 'idle') {
      flow = new LoginFlow({
        onToken: async (token) => { await setSetting(app.pool, KEYS.claudeToken, token, currentUser.id); app.log.info('token do Claude salvo pelo login no navegador'); },
        onFileAuth: async () => { app.log.info('login do Claude concluído via claude auth login (sessão no arquivo de credenciais, sem token estático)'); },
      });
      flow.start();
    }
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 40 && !flow.url && flow.state !== 'error'; i++) await new Promise(r => setTimeout(r, 250));
    return flow.snapshot();
  });
  app.get('/api/settings/claude-login', async () => flow ? flow.snapshot() : { state: 'idle', url: null, error: null, started_at: null, output_tail: '' });
  app.post<{ Body: { code?: string } }>('/api/settings/claude-login/code', async (req, reply) => {
    if (!flow) return reply.code(400).send({ error: 'login não iniciado' });
    if (!flow.submitCode(req.body?.code ?? '')) return reply.code(400).send({ error: `não dá para enviar o código agora (estado ${flow.state})` });
    for (let i = 0; i < 120 && flow.state === 'exchanging'; i++) await new Promise(r => setTimeout(r, 250));
    return flow.snapshot();
  });
  app.post('/api/settings/claude-login/cancel', async () => { flow?.cancel(); return flow ? flow.snapshot() : { state: 'idle' }; });

  app.put<{ Body: { permission_mode?: string; model?: string; max_budget_usd?: number } }>('/api/settings/defaults', async (req, reply) => {
    const b = req.body ?? {};
    if (b.permission_mode !== undefined) {
      if (!['acceptEdits', 'default', 'plan', 'auto'].includes(b.permission_mode)) return reply.code(400).send({ error: 'modo inválido' });
      await setSetting(app.pool, KEYS.defaultMode, b.permission_mode, req.user!.id);
    }
    if (b.model !== undefined) await setSetting(app.pool, KEYS.defaultModel, String(b.model).trim(), req.user!.id);
    if (b.max_budget_usd !== undefined) {
      const n = Number(b.max_budget_usd);
      if (!(n > 0 && n <= 500)) return reply.code(400).send({ error: 'orçamento entre 0 e 500' });
      await setSetting(app.pool, KEYS.maxBudgetUsd, String(n), req.user!.id);
    }
    return { ok: true };
  });
}
