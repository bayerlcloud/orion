import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  NOTA_INICIAL,
  ValidationError,
  normalizeKeywords,
  normalizeLevel,
  normalizeNota,
  normalizeScopeId,
  normalizeSummary,
  slugify,
  uniqueCode,
} from '../memories/util.js';
import { ensureMemoriesSchema } from '../memories/migrate.js';
import { seedMemories, seedPerfisNivel2 } from '../memories/seed.js';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { claudeMemoryDir, parseFrontmatter, toMarkdown, isSafeMdName } from '../memories/markdown.js';
import { gravarEmbedding } from '../memories/embed.js';

// Colunas completas (leitor da direita) já com os nomes de projeto e usuário resolvidos.
const FULL_SELECT = `
  SELECT m.id, m.code, m.title, m.summary, m.body_md, m.level, m.nota, m.rewritable,
         m.keywords, m.scope_project_id, m.scope_user_id,
         p.name AS project_name, u.name AS user_name,
         m.created_at, m.updated_at, m.last_accessed_at, m.last_accessed_session, m.last_accessed_reason,
         m.last_analyzed_at, m.last_rewritten_at, m.last_decay_at
    FROM memories m
    LEFT JOIN projects p ON p.id = m.scope_project_id
    LEFT JOIN users u ON u.id = m.scope_user_id`;

// Ordem canônica da pirâmide: nível mais alto primeiro; dentro do 4, nota maior primeiro.
const ORDER_BY = 'ORDER BY m.level ASC, m.nota DESC NULLS LAST, m.updated_at DESC';

// Traduz erros de validação e violações do Postgres para HTTP.
// Genérico para preservar os tipos de Params/Querystring/Body de cada rota.
function guard<Req extends FastifyRequest>(
  fn: (req: Req, reply: FastifyReply) => Promise<unknown>,
): (req: Req, reply: FastifyReply) => Promise<unknown> {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
    if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
    const code = (e as { code?: string })?.code;
    if (code === '23505') return reply.code(409).send({ error: 'já existe uma memória com esse código' });
    if (code === '23503') return reply.code(400).send({ error: 'projeto ou usuário do escopo não existe' });
      if (code === '23514') return reply.code(400).send({ error: 'combinação de nível e nota inválida' });
      throw e;
    }
  };
}

function intParam(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${name} inválido`);
  return n;
}

function reqTitle(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) throw new ValidationError('título é obrigatório');
  return t;
}

export async function memoriesRoutes(app: FastifyInstance) {
  // A tabela nasce do próprio plugin (não há migração em migrations.ts para esta feature).
  // Instalação nova já nasce no esquema de níveis; instalação antiga é migrada logo abaixo.
  await app.pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body_md TEXT NOT NULL DEFAULT '',
      level INT NOT NULL DEFAULT 4,
      nota INT,
      rewritable BOOLEAN NOT NULL DEFAULT true,
      keywords TEXT[] NOT NULL DEFAULT '{}',
      scope_project_id INT REFERENCES projects(id) ON DELETE SET NULL,
      scope_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_accessed_at TIMESTAMPTZ,
      last_accessed_session TEXT,
      last_accessed_reason TEXT,
      last_analyzed_at TIMESTAMPTZ,
      last_rewritten_at TIMESTAMPTZ,
      last_decay_at TIMESTAMPTZ,
      CONSTRAINT memories_nivel_ck CHECK (level BETWEEN 0 AND 4),
      CONSTRAINT memories_nota_ck CHECK ((level = 4 AND nota BETWEEN 1 AND 10) OR (level <> 4 AND nota IS NULL))
    );
    CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories (updated_at DESC);
  `);
  await ensureMemoriesSchema(app.pool);
  await seedMemories(app.pool);
  // Perfis nível 2 por pessoa (idempotente): quem já tem memória nível 2 de escopo próprio é pulado.
  await seedPerfisNivel2(app.pool);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  // Listas para os selects de escopo.
  app.get('/api/memories/meta', guard(async () => {
    const projects = await app.pool.query('SELECT id, name FROM projects ORDER BY name');
    const users = await app.pool.query('SELECT id, name FROM users ORDER BY name');
    return { projects: projects.rows, users: users.rows };
  }));

  // Lista filtrável, ordenada pela pirâmide (nível, depois nota, depois atualização).
  app.get<{ Querystring: { q?: string; level?: string; scope?: string } }>(
    '/api/memories',
    guard(async (req) => {
      const { q, level, scope } = (req.query ?? {}) as { q?: string; level?: string; scope?: string };
      const where: string[] = [];
      const params: unknown[] = [];

      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        const p = `$${params.length}`;
        where.push(`(m.title ILIKE ${p} OR m.summary ILIKE ${p} OR EXISTS (SELECT 1 FROM unnest(m.keywords) k WHERE k ILIKE ${p}))`);
      }
      if (level !== undefined && level !== '') {
        params.push(normalizeLevel(level));
        where.push(`m.level = $${params.length}`);
      }
      if (scope === 'universais') where.push('m.scope_project_id IS NULL AND m.scope_user_id IS NULL');
      else if (scope === 'projeto') where.push('m.scope_project_id IS NOT NULL');
      else if (scope === 'usuario') where.push('m.scope_user_id IS NOT NULL');

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await app.pool.query(
        `SELECT m.id, m.code, m.title, m.summary, m.level, m.nota, m.keywords,
                m.scope_project_id, m.scope_user_id, p.name AS project_name, u.name AS user_name,
                m.created_at, m.last_accessed_at
           FROM memories m
           LEFT JOIN projects p ON p.id = m.scope_project_id
           LEFT JOIN users u ON u.id = m.scope_user_id
           ${whereSql}
           ${ORDER_BY}`,
        params,
      );
      return { memories: rows };
    }),
  );

  // Detalhe completo. Registra o acesso (a IA pode sobrescrever motivo/sessão pela query).
  app.get<{ Params: { id: string }; Querystring: { reason?: string; session?: string } }>(
    '/api/memories/:id',
    guard(async (req, reply) => {
      const id = intParam(req.params.id, 'id');
      const session = typeof req.query.session === 'string' && req.query.session ? req.query.session : 'painel';
      const reason =
        typeof req.query.reason === 'string' && req.query.reason
          ? req.query.reason
          : `aberta no painel Memória por ${req.user!.name}`;
      const { rows } = await app.pool.query(
        `${FULL_SELECT} WHERE m.id = $1`,
        [id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'memória não encontrada' });
      await app.pool.query(
        `UPDATE memories SET last_accessed_at = now(), last_accessed_session = $2, last_accessed_reason = $3 WHERE id = $1`,
        [id, session, reason],
      );
      const { rows: fresh } = await app.pool.query(`${FULL_SELECT} WHERE m.id = $1`, [id]);
      return { memory: fresh[0] };
    }),
  );

  // Cria (title obrigatório; valida tudo; gera o código). Sem nível informado nasce micro-fato.
  app.post<{ Body: Record<string, unknown> }>(
    '/api/memories',
    guard(async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const title = reqTitle(b.title);
      const level = b.level === undefined ? 4 : normalizeLevel(b.level);
      const nota = normalizeNota(level, b.nota);
      const summary = normalizeSummary(b.summary);
      const keywords = normalizeKeywords(b.keywords);
      const body_md = typeof b.body_md === 'string' ? b.body_md : '';
      const rewritable = b.rewritable === undefined ? true : Boolean(b.rewritable);
      const scope_project_id = normalizeScopeId(b.scope_project_id);
      const scope_user_id = normalizeScopeId(b.scope_user_id);
      const code = await uniqueCode(
        (sql, params) => app.pool.query(sql, params),
        typeof b.code === 'string' && b.code.trim() ? b.code : title,
      );

      const { rows } = await app.pool.query(
        `INSERT INTO memories (code, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [code, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id],
      );
      // Embedding em segundo plano (best-effort): sem a migração pgvector é um no-op.
      void gravarEmbedding((sql, params) => app.pool.query(sql, params as any[]), rows[0].id, title, summary, body_md);
      const { rows: fresh } = await app.pool.query(`${FULL_SELECT} WHERE m.id = $1`, [rows[0].id]);
      return reply.code(201).send({ memory: fresh[0] });
    }),
  );

  // Atualiza os campos enviados. body_md muda -> last_rewritten_at; sempre updated_at.
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/memories/:id',
    guard(async (req, reply) => {
      const id = intParam(req.params.id, 'id');
      const cur = await app.pool.query(
        `SELECT title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id FROM memories WHERE id = $1`,
        [id],
      );
      if (!cur.rows[0]) return reply.code(404).send({ error: 'memória não encontrada' });
      const c = cur.rows[0];
      const b = (req.body ?? {}) as Record<string, unknown>;

      const title = b.title === undefined ? c.title : reqTitle(b.title);
      const level = b.level === undefined ? c.level : normalizeLevel(b.level);
      // Se o nível mudou e a nota não veio, recalcula a partir do enviado (4 ganha a nota inicial;
      // fora do 4 zera). Nível igual e nota ausente mantém a atual.
      const rawNota = b.nota === undefined ? (b.level === undefined ? c.nota : null) : b.nota;
      const nota = normalizeNota(level, rawNota);
      const summary = b.summary === undefined ? c.summary : normalizeSummary(b.summary);
      const keywords = b.keywords === undefined ? c.keywords : normalizeKeywords(b.keywords);
      const rewritable = b.rewritable === undefined ? c.rewritable : Boolean(b.rewritable);
      const scope_project_id = b.scope_project_id === undefined ? c.scope_project_id : normalizeScopeId(b.scope_project_id);
      const scope_user_id = b.scope_user_id === undefined ? c.scope_user_id : normalizeScopeId(b.scope_user_id);
      const body_md = b.body_md === undefined ? c.body_md : typeof b.body_md === 'string' ? b.body_md : '';
      const bodyChanged = b.body_md !== undefined && body_md !== c.body_md;

      await app.pool.query(
        `UPDATE memories SET title=$2, summary=$3, body_md=$4, level=$5, nota=$6, rewritable=$7,
                keywords=$8, scope_project_id=$9, scope_user_id=$10, updated_at=now()
                ${bodyChanged ? ', last_rewritten_at=now()' : ''}
          WHERE id=$1`,
        [id, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id],
      );
      // Corpo (ou título/resumo) mudou: recalcula o embedding em segundo plano (best-effort;
      // sem a migração pgvector é um no-op e o backfill do deploy cobre).
      if (bodyChanged || title !== c.title || summary !== c.summary) {
        void gravarEmbedding((sql, params) => app.pool.query(sql, params as any[]), id, title, summary, body_md);
      }
      const { rows: fresh } = await app.pool.query(`${FULL_SELECT} WHERE m.id = $1`, [id]);
      return { memory: fresh[0] };
    }),
  );

  // Marca análise da IA (stub para o runner chamar depois).
  app.post<{ Params: { id: string } }>(
    '/api/memories/:id/analyzed',
    guard(async (req, reply) => {
      const id = intParam(req.params.id, 'id');
      const upd = await app.pool.query('UPDATE memories SET last_analyzed_at = now() WHERE id = $1', [id]);
      if (!upd.rowCount) return reply.code(404).send({ error: 'memória não encontrada' });
      const { rows } = await app.pool.query(`${FULL_SELECT} WHERE m.id = $1`, [id]);
      return { memory: rows[0] };
    }),
  );

  // ---- Ponte com as memórias que o Claude escreve em disco ----
  async function projetoDir(projectId: number): Promise<{ dir: string; project: { id: number; path: string; name: string } } | null> {
    const { rows } = await app.pool.query('SELECT id, path, name FROM projects WHERE id = $1', [projectId]);
    if (!rows[0]) return null;
    return { dir: claudeMemoryDir(homedir(), rows[0].path), project: rows[0] };
  }

  // Importa os .md que o Claude criou para a tabela do painel (upsert por code).
  // type user vira regra do usuário (nível 2), type project regra do projeto (nível 2);
  // o resto entra no enxame como micro-fato (nível 4, nota inicial).
  app.post<{ Body: { project_id?: number } }>(
    '/api/memories/import',
    guard(async (req, reply) => {
      const pid = Number(req.body?.project_id);
      if (!Number.isInteger(pid)) return reply.code(400).send({ error: 'informe project_id' });
      const info = await projetoDir(pid);
      if (!info) return reply.code(404).send({ error: 'projeto não existe' });
      let arquivos: string[] = [];
      try { arquivos = (await readdir(info.dir)).filter(f => isSafeMdName(f) && f.toLowerCase() !== 'memory.md'); }
      catch { return { importadas: 0, dir: info.dir, aviso: 'o Claude ainda não escreveu memórias para este projeto' }; }
      let n = 0; const nomes: string[] = [];
      for (const f of arquivos) {
        const raw = await readFile(path.join(info.dir, f), 'utf8').catch(() => '');
        if (!raw) continue;
        const parsed = parseFrontmatter(raw);
        const code = slugify(parsed.name || f.replace(/\.md$/, ''));
        const title = (parsed.name || f.replace(/\.md$/, '')).replace(/[-_]/g, ' ');
        const summary = normalizeSummary(parsed.description || '');
        const level = parsed.type === 'project' || parsed.type === 'user' ? 2 : 4;
        const nota = level === 4 ? NOTA_INICIAL : null;
        const scopeProject = parsed.type === 'project' ? pid : null;
        const scopeUser = parsed.type === 'user' ? (req.user!.id) : null;
        await app.pool.query(
          `INSERT INTO memories (code, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id, last_analyzed_at)
           VALUES ($1,$2,$3,$4,$5,$6,true,'{}',$7,$8, now())
           ON CONFLICT (code) DO UPDATE SET summary = EXCLUDED.summary, body_md = EXCLUDED.body_md, updated_at = now()`,
          [code, title, summary, parsed.body, level, nota, scopeProject, scopeUser]);
        n++; nomes.push(code);
      }
      return { importadas: n, dir: info.dir, memorias: nomes };
    }),
  );

  // Exporta as memórias do painel (deste projeto + universais) para a pasta que o Claude lê.
  app.post<{ Body: { project_id?: number } }>(
    '/api/memories/export',
    guard(async (req, reply) => {
      const pid = Number(req.body?.project_id);
      if (!Number.isInteger(pid)) return reply.code(400).send({ error: 'informe project_id' });
      const info = await projetoDir(pid);
      if (!info) return reply.code(404).send({ error: 'projeto não existe' });
      try { await mkdir(info.dir, { recursive: true }); } catch { return reply.code(500).send({ error: 'não consegui criar a pasta de memórias' }); }
      const { rows } = await app.pool.query(
        `SELECT code, title, summary, body_md, level, scope_project_id, scope_user_id FROM memories
          WHERE scope_project_id = $1 OR (scope_project_id IS NULL AND scope_user_id IS NULL) ORDER BY code`, [pid]);
      const indice: string[] = [];
      for (const m of rows) {
        const scope = m.scope_project_id ? 'project' : (m.scope_user_id ? 'user' : 'reference');
        const nome = `${m.code}.md`;
        if (!isSafeMdName(nome)) continue;
        await writeFile(path.join(info.dir, nome), toMarkdown({ code: m.code, title: m.title, summary: m.summary, body_md: m.body_md, scope: scope as any }), 'utf8');
        indice.push(`- [${m.title}](${nome}): ${m.summary}`);
      }
      await writeFile(path.join(info.dir, 'MEMORY.md'), `# Memórias do projeto ${info.project.name}\n\n${indice.join('\n')}\n`, 'utf8');
      return { exportadas: rows.length, dir: info.dir };
    }),
  );

  // Excluir: só o admin (owner).
  app.delete<{ Params: { id: string } }>(
    '/api/memories/:id',
    guard(async (req, reply) => {
      if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin pode excluir memórias' });
      const id = intParam(req.params.id, 'id');
      const del = await app.pool.query('DELETE FROM memories WHERE id = $1', [id]);
      if (!del.rowCount) return reply.code(404).send({ error: 'memória não encontrada' });
      return { ok: true };
    }),
  );
}
