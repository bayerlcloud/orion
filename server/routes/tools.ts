import type { FastifyInstance } from 'fastify';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { HOSTINGER_MCPS, KEYS, getSetting, hostingerVpsCount, maskToken, sdkEnv, setSetting } from '../settings.js';
import { ATIVACAO_LABEL, CATALOGO_DIR, chaveDe, raizesPadrao, scanTudo, type SkillItem } from '../tools/skillsScan.js';
import { TODOS, ehDoCatalogo, ensureSkillPrefsTable, estadoDe, gravarPref, invalidarCatalogo, lerPrefs } from '../tools/skillPrefs.js';
import { ensureGithubAccountsTable, githubLoginDe, listarContasGithub, looksLikeGithubToken, maskGithubToken, nomeMcpGithub, type GithubAccount } from '../tools/githubAccounts.js';
import { cloudflareContaDe, ensureCloudflareAccountsTable, listarContasCloudflare, looksLikeCloudflareAccountId, looksLikeCloudflareToken, maskCloudflareToken, nomeConectorCloudflare, urlDoConector, type CloudflareAccount } from '../tools/cloudflareAccounts.js';

const KINDS = new Set(['tool', 'skill', 'mcp']);

type ToolBody = { kind?: string; name?: string; description?: string; icon?: string; status?: string; link?: string; details?: string };

function intParam(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function toolsRoutes(app: FastifyInstance) {
  // Explicação em pt-BR por skill, compartilhada entre cópias (chave = tipo:invocação).
  await app.pool.query('CREATE TABLE IF NOT EXISTS skill_notes (chave TEXT PRIMARY KEY, descricao_pt TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await ensureSkillPrefsTable(app.pool);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  // ---------- skills descobertas no disco ----------
  // ponytail: cache de 60 s em memória; a varredura lê centenas de .md. Invalida em ativar/explicar.
  let cache: { ts: number; itens: SkillItem[] } | null = null;
  async function listar(force = false): Promise<SkillItem[]> {
    if (!force && cache && Date.now() - cache.ts < 60_000) return cache.itens;
    const { rows: projetos } = await app.pool.query('SELECT slug, path FROM projects ORDER BY id');
    const itens = await scanTudo(raizesPadrao(projetos));
    const { rows: notas } = await app.pool.query('SELECT chave, descricao_pt FROM skill_notes');
    const pt = new Map<string, string>(notas.map((n: any) => [n.chave, n.descricao_pt]));
    for (const it of itens) it.descricao_pt = pt.get(chaveDe(it.kind, it.invocacao)) ?? null;
    cache = { ts: Date.now(), itens };
    return itens;
  }

  app.get('/api/tools/skills', async (req) => {
    const base = await listar();
    const prefs = await lerPrefs(app.pool);
    // Estado por item para quem está olhando. Só itens do catálogo têm botão; o resto é informativo.
    const itens = base.map(it => {
      const chave = chaveDe(it.kind, it.invocacao);
      const ligavel = ehDoCatalogo(it);
      const e = estadoDe(chave, req.user!.id, prefs);
      return { ...it, chave, ligavel, ligada_todos: ligavel ? e.todos : null, ligada_eu: ligavel ? e.eu : null, efetiva: ligavel ? e.efetiva : it.habilitada };
    });
    const faltam = new Set(itens.filter(i => !i.descricao_pt && i.kind !== 'hook').map(i => i.chave)).size;
    return { itens, faltam_pt: faltam, ativacao_label: ATIVACAO_LABEL, catalogo_dir: CATALOGO_DIR };
  });

  /** Liga/desliga uma skill do catálogo: escopo "todos" (só owner) ou "eu"; ligada=null apaga a escolha (volta ao padrão). */
  app.put<{ Body: { chave?: string; escopo?: string; ligada?: boolean | null } }>('/api/tools/skills/prefs', async (req, reply) => {
    const b = req.body ?? {};
    const chave = String(b.chave ?? '').trim();
    if (!chave) return reply.code(400).send({ error: 'chave é obrigatória' });
    const escopo = b.escopo === 'todos' ? 'todos' : 'eu';
    if (escopo === 'todos' && req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin muda o padrão de todos' });
    const ligada = b.ligada === null || b.ligada === undefined ? null : Boolean(b.ligada);
    const item = (await listar()).find(i => chaveDe(i.kind, i.invocacao) === chave && ehDoCatalogo(i));
    if (!item) return reply.code(404).send({ error: 'essa skill não está no catálogo (só itens do catálogo têm botão)' });
    await gravarPref(app.pool, chave, escopo === 'todos' ? TODOS : req.user!.id, ligada);
    return { ok: true, ...estadoDe(chave, req.user!.id, await lerPrefs(app.pool)) };
  });

  app.get<{ Params: { id: string } }>('/api/tools/skills/:id/md', async (req, reply) => {
    const it = (await listar()).find(i => i.id === req.params.id);
    if (!it) return reply.code(404).send({ error: 'não encontrada' });
    if (it.kind === 'hook') return { md: '```\n' + it.description + '\n```' };
    if (it.credencial && req.user!.role !== 'owner') return reply.code(403).send({ error: 'este arquivo parece conter credencial; só o admin vê o conteúdo' });
    const st = await stat(it.path).catch(() => null);
    if (!st || st.size > 300_000) return reply.code(413).send({ error: 'arquivo grande demais para mostrar' });
    return { md: await readFile(it.path, 'utf8') };
  });

  /** Copia uma skill/command/agent solto do snapshot do code-server para a casa do Claude na c3. */
  app.post<{ Params: { id: string } }>('/api/tools/skills/:id/ativar', async (req, reply) => {
    if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    const it = (await listar()).find(i => i.id === req.params.id);
    if (!it) return reply.code(404).send({ error: 'não encontrada' });
    if (it.origem !== 'code-server' || it.plugin || it.kind === 'hook') {
      return reply.code(400).send({ error: 'só skills, commands e agents soltos do code-server; plugin entra no catálogo por deploy/catalogo.sh' });
    }
    let destino: string;
    if (it.kind === 'skill') destino = path.join(CATALOGO_DIR, 'skills', path.basename(path.dirname(it.path)));
    else if (it.kind === 'command') destino = path.join(CATALOGO_DIR, 'commands', ...it.name.split(':')) + '.md';
    else destino = path.join(CATALOGO_DIR, 'agents', `${it.name}.md`);
    if (await stat(destino).catch(() => null)) return reply.code(409).send({ error: `já existe na c3: ${destino}` });
    await mkdir(path.dirname(destino), { recursive: true });
    await cp(it.kind === 'skill' ? path.dirname(it.path) : it.path, destino, { recursive: true });
    cache = null; invalidarCatalogo();
    app.log.info(`skill ativada no catálogo por ${req.user!.email}: ${it.invocacao} -> ${destino}`);
    return { ok: true, destino, aviso: it.refs_code_server ? 'cita caminhos /config/... do code-server; revise antes de usar' : null };
  });

  /** Gera explicações em pt-BR (lote de até 30 chaves sem nota) com um turno de Haiku, sem ferramentas. */
  app.post('/api/tools/skills/explicar', async (req, reply) => {
    if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin' });
    const itens = await listar(true);
    const pendentes = new Map<string, SkillItem>();
    for (const it of itens) if (!it.descricao_pt && it.kind !== 'hook' && !pendentes.has(chaveDe(it.kind, it.invocacao))) pendentes.set(chaveDe(it.kind, it.invocacao), it);
    const lote = [...pendentes.entries()].slice(0, 30);
    if (!lote.length) return { explicadas: 0, faltam: 0, cost_usd: 0 };
    const entrada = await Promise.all(lote.map(async ([chave, it]) => ({
      id: chave, tipo: it.kind, nome: it.invocacao, description: it.description.slice(0, 600),
      inicio: (await readFile(it.path, 'utf8').catch(() => '')).replace(/^---[\s\S]*?---\n?/, '').split('\n').slice(0, 25).join('\n').slice(0, 1200),
    })));
    const prompt = 'Você recebe uma lista JSON de skills, commands e subagentes do Claude Code (id, tipo, nome, description em inglês e o começo do arquivo).\n'
      + 'Para cada id escreva, em português do Brasil, 1 ou 2 frases explicando para uma pessoa leiga o que aquilo faz e quando é usado. Sem travessão (use vírgula ou ponto).\n'
      + 'Responda SOMENTE com um objeto JSON no formato {"<id>": "texto"}, sem comentários.\n\n' + JSON.stringify(entrada);
    const token = await getSetting(app.pool, KEYS.claudeToken);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    let texto = '', cost = 0, erro = '';
    try {
      const q = query({ prompt, options: {
        cwd: '/tmp', maxTurns: 1, tools: [], permissionMode: 'default', settingSources: [], abortController: abort, env: sdkEnv(token),
        model: 'claude-haiku-4-5-20251001', systemPrompt: 'Você explica ferramentas de programação em português simples. Responda só JSON.',
      } });
      for await (const m of q) {
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') texto += b.text;
        if (m.type === 'result') { cost = m.total_cost_usd ?? 0; if (m.is_error) erro = (m as any).result ?? m.subtype; }
      }
    } catch (e: any) { erro = String(e?.message ?? e); } finally { clearTimeout(timer); }
    if (erro) return reply.code(502).send({ error: `Claude falhou: ${erro}` });
    let mapa: Record<string, string> = {};
    try { mapa = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1)); }
    catch { return reply.code(502).send({ error: 'resposta do Claude não veio em JSON', trecho: texto.slice(0, 200) }); }
    let n = 0;
    for (const [chave] of lote) {
      const t = String(mapa[chave] ?? '').replace(/[\u2014\u2013]/g, ',').trim();
      if (!t) continue;
      await app.pool.query('INSERT INTO skill_notes (chave, descricao_pt) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET descricao_pt = EXCLUDED.descricao_pt, updated_at = now()', [chave, t]);
      n++;
    }
    cache = null;
    return { explicadas: n, faltam: pendentes.size - n, cost_usd: cost };
  });

  // ---------- contas GitHub (cada uma vira um MCP em toda sessão; token nunca sai daqui) ----------
  await ensureGithubAccountsTable(app.pool);
  await ensureCloudflareAccountsTable(app.pool);
  const contaPublica = (c: GithubAccount) => ({ id: c.id, label: c.label, login: c.login, email: c.email, notes: c.notes, mcp: nomeMcpGithub(c.label), token_hint: maskGithubToken(c.token) });
  const soAdmin = (req: any, reply: any) => req.user!.role !== 'owner' ? reply.code(403).send({ error: 'só o admin' }) : null;

  app.get('/api/tools/github', async () => ({ contas: (await listarContasGithub(app.pool)).map(contaPublica) }));

  app.post<{ Body: { label?: string; token?: string; email?: string; notes?: string } }>('/api/tools/github', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const label = (req.body?.label ?? '').trim(); const token = (req.body?.token ?? '').trim(); const notes = (req.body?.notes ?? '').trim(); const email = (req.body?.email ?? '').trim();
    if (!label) return reply.code(400).send({ error: 'nome é obrigatório' });
    if (!looksLikeGithubToken(token)) return reply.code(400).send({ error: 'isso não parece um token do GitHub (ghp_… ou github_pat_…)' });
    const login = await githubLoginDe(token);
    if (!login) return reply.code(400).send({ error: 'o GitHub recusou esse token' });
    const { rows } = await app.pool.query(
      `INSERT INTO github_accounts (label, login, token, notes, email, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (label) DO UPDATE SET login = EXCLUDED.login, token = EXCLUDED.token, notes = EXCLUDED.notes, email = EXCLUDED.email, updated_at = now()
       RETURNING id, label, login, email, token, notes`, [label, login, token, notes, email, req.user!.id]);
    return reply.code(201).send({ conta: contaPublica(rows[0]) });
  });

  app.put<{ Params: { id: string }; Body: { label?: string; email?: string; notes?: string } }>('/api/tools/github/:id', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const id = intParam(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id inválido' });
    const { rows } = await app.pool.query(
      `UPDATE github_accounts SET label = COALESCE(NULLIF($2::text, ''), label), notes = COALESCE($3::text, notes), email = COALESCE($4::text, email), updated_at = now()
        WHERE id = $1 RETURNING id, label, login, email, token, notes`, [id, (req.body?.label ?? '').trim(), req.body?.notes === undefined ? null : req.body.notes.trim(), req.body?.email === undefined ? null : req.body.email.trim()]);
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' });
    return { conta: contaPublica(rows[0]) };
  });

  app.delete<{ Params: { id: string } }>('/api/tools/github/:id', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const id = intParam(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id inválido' });
    const del = await app.pool.query('DELETE FROM github_accounts WHERE id = $1', [id]);
    if (!del.rowCount) return reply.code(404).send({ error: 'não encontrada' });
    return { ok: true };
  });

  // ---------- conta Hostinger (um token só, na tabela settings; vira os MCPs hostinger-* em toda sessão) ----------
  app.get('/api/tools/hostinger', async () => {
    const token = await getSetting(app.pool, KEYS.hostingerToken);
    return { conectado: !!token, token_hint: maskToken(token), mcps: HOSTINGER_MCPS };
  });

  app.put<{ Body: { token?: string } }>('/api/tools/hostinger', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const token = (req.body?.token ?? '').trim();
    if (token.length < 20) return reply.code(400).send({ error: 'token vazio ou curto demais' });
    if (await hostingerVpsCount(token) === null) return reply.code(400).send({ error: 'a Hostinger recusou esse token' });
    await setSetting(app.pool, KEYS.hostingerToken, token, req.user!.id);
    app.log.info(`token da Hostinger trocado por ${req.user!.email}`);
    return { conectado: true, token_hint: maskToken(token), mcps: HOSTINGER_MCPS };
  });

  // ---------- contas Cloudflare (conector simples; tabela e rotas no desenho das contas GitHub) ----------
  const cfPublica = (c: CloudflareAccount) => ({ id: c.id, label: c.label, account_id: c.account_id, account_name: c.account_name, email: c.email, notes: c.notes, nome: nomeConectorCloudflare(c.label), url: urlDoConector(nomeConectorCloudflare(c.label)), token_hint: maskCloudflareToken(c.token) });

  app.get('/api/tools/cloudflare', async () => ({ contas: (await listarContasCloudflare(app.pool)).map(cfPublica) }));

  app.post<{ Body: { label?: string; account_id?: string; token?: string; email?: string; notes?: string } }>('/api/tools/cloudflare', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const label = (req.body?.label ?? '').trim(); const accountId = (req.body?.account_id ?? '').trim(); const token = (req.body?.token ?? '').trim();
    const notes = (req.body?.notes ?? '').trim(); const email = (req.body?.email ?? '').trim();
    if (!label) return reply.code(400).send({ error: 'nome é obrigatório' });
    if (!looksLikeCloudflareAccountId(accountId)) return reply.code(400).send({ error: 'account ID precisa ter 32 caracteres hexadecimais' });
    if (!looksLikeCloudflareToken(token)) return reply.code(400).send({ error: 'isso não parece um token da Cloudflare (cfat_…, cfut_… ou 40 caracteres)' });
    const accountName = await cloudflareContaDe(accountId, token);
    if (accountName === null) return reply.code(400).send({ error: 'a Cloudflare recusou esse token para essa conta' });
    const { rows } = await app.pool.query(
      `INSERT INTO cloudflare_accounts (label, account_id, account_name, token, notes, email, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (label) DO UPDATE SET account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name, token = EXCLUDED.token, notes = EXCLUDED.notes, email = EXCLUDED.email, updated_at = now()
       RETURNING id, label, account_id, account_name, email, token, notes`, [label, accountId, accountName, token, notes, email, req.user!.id]);
    return reply.code(201).send({ conta: cfPublica(rows[0]) });
  });

  app.put<{ Params: { id: string }; Body: { label?: string; email?: string; notes?: string } }>('/api/tools/cloudflare/:id', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const id = intParam(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id inválido' });
    const { rows } = await app.pool.query(
      `UPDATE cloudflare_accounts SET label = COALESCE(NULLIF($2::text, ''), label), notes = COALESCE($3::text, notes), email = COALESCE($4::text, email), updated_at = now()
        WHERE id = $1 RETURNING id, label, account_id, account_name, email, token, notes`, [id, (req.body?.label ?? '').trim(), req.body?.notes === undefined ? null : req.body.notes.trim(), req.body?.email === undefined ? null : req.body.email.trim()]);
    if (!rows[0]) return reply.code(404).send({ error: 'não encontrada' });
    return { conta: cfPublica(rows[0]) };
  });

  app.delete<{ Params: { id: string } }>('/api/tools/cloudflare/:id', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const id = intParam(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id inválido' });
    const del = await app.pool.query('DELETE FROM cloudflare_accounts WHERE id = $1', [id]);
    if (!del.rowCount) return reply.code(404).send({ error: 'não encontrada' });
    return { ok: true };
  });

  // ---------- catálogo manual (tabela tools) ----------

  app.get('/api/tools', async () => {
    const { rows } = await app.pool.query(
      `SELECT t.id, t.kind, t.name, t.description, t.icon, t.status, t.link, t.details, t.created_at, t.updated_at, u.name AS created_by_name
         FROM tools t LEFT JOIN users u ON u.id = t.created_by
        ORDER BY t.kind, t.name`);
    return { tools: rows };
  });

  app.post<{ Body: ToolBody }>('/api/tools', async (req, reply) => {
    const b = req.body ?? {};
    const kind = KINDS.has(b.kind ?? '') ? b.kind! : null;
    const name = (b.name ?? '').trim();
    if (!kind) return reply.code(400).send({ error: 'kind precisa ser tool, skill ou mcp' });
    if (!name) return reply.code(400).send({ error: 'nome é obrigatório' });
    const description = (b.description ?? '').trim();
    const icon = (b.icon ?? '').trim() || '⚙️';
    const status = b.status === 'inativo' ? 'inativo' : 'ativo';
    const link = (b.link ?? '').trim() || null;
    const details = (b.details ?? '').trim();
    const { rows } = await app.pool.query(
      `INSERT INTO tools (kind, name, description, icon, status, link, details, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, kind, name, description, icon, status, link, details, created_at, updated_at`,
      [kind, name, description, icon, status, link, details, req.user!.id]);
    return reply.code(201).send({ tool: { ...rows[0], created_by_name: req.user!.name } });
  });

  app.put<{ Params: { id: string }; Body: ToolBody }>('/api/tools/:id', async (req, reply) => {
    const id = intParam(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id inválido' });
    const cur = await app.pool.query('SELECT kind, name, description, icon, status, link, details FROM tools WHERE id = $1', [id]);
    const c = cur.rows[0];
    if (!c) return reply.code(404).send({ error: 'não encontrada' });
    const b = req.body ?? {};
    const kind = b.kind === undefined ? c.kind : (KINDS.has(b.kind ?? '') ? b.kind : null);
    if (!kind) return reply.code(400).send({ error: 'kind precisa ser tool, skill ou mcp' });
    const name = b.name === undefined ? c.name : b.name.trim();
    if (!name) return reply.code(400).send({ error: 'nome é obrigatório' });
    const description = b.description === undefined ? c.description : b.description.trim();
    const icon = b.icon === undefined ? c.icon : (b.icon.trim() || '⚙️');
    const status = b.status === undefined ? c.status : (b.status === 'inativo' ? 'inativo' : 'ativo');
    const link = b.link === undefined ? c.link : (b.link.trim() || null);
    const details = b.details === undefined ? c.details : b.details.trim();
    const { rows } = await app.pool.query(
      `UPDATE tools SET kind=$2, name=$3, description=$4, icon=$5, status=$6, link=$7, details=$8, updated_at=now() WHERE id=$1
       RETURNING id, kind, name, description, icon, status, link, details, created_at, updated_at`,
      [id, kind, name, description, icon, status, link, details]);
    return { tool: rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/api/tools/:id', async (req, reply) => {
    const id = intParam(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id inválido' });
    const del = await app.pool.query('DELETE FROM tools WHERE id = $1', [id]);
    if (!del.rowCount) return reply.code(404).send({ error: 'não encontrada' });
    return { ok: true };
  });
}
