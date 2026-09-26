import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ValidationError,
  importanceRank,
  normalizeKeywords,
  normalizeLearningLevel,
  normalizeScopeId,
  normalizeStatus,
  normalizeSummary,
  slugify,
  type Status,
} from '../memories/util.js';
import { seedMemories } from '../memories/seed.js';

// Colunas completas (leitor da direita) já com os nomes de projeto e usuário resolvidos.
const FULL_SELECT = `
  SELECT m.id, m.code, m.title, m.summary, m.body_md, m.status, m.learning_level, m.rewritable,
         m.keywords, m.scope_project_id, m.scope_user_id,
         p.name AS project_name, u.name AS user_name,
         m.created_at, m.updated_at, m.last_accessed_at, m.last_accessed_session, m.last_accessed_reason,
         m.last_analyzed_at, m.last_rewritten_at
    FROM memories m
    LEFT JOIN projects p ON p.id = m.scope_project_id
    LEFT JOIN users u ON u.id = m.scope_user_id`;

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
      if (code === '23514') return reply.code(400).send({ error: 'combinação de status e nível inválida' });
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

async function uniqueCode(app: FastifyInstance, base: string, excludeId?: number): Promise<string> {
  const clean = slugify(base);
  let code = clean;
  let n = 1;
  // Sequência: base, base-2, base-3, ...
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rowCount } = await app.pool.query(
      'SELECT 1 FROM memories WHERE code = $1 AND ($2::int IS NULL OR id <> $2)',
      [code, excludeId ?? null],
    );
    if (!rowCount) return code;
    n += 1;
    code = `${clean}-${n}`;
  }
}

export async function memoriesRoutes(app: FastifyInstance) {
  // A tabela nasce do próprio plugin (não há migração para esta feature).
  await app.pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body_md TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('deus','aprendizagem','rascunho')),
      learning_level INT,
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
      CONSTRAINT memories_level_ck CHECK (
        (status = 'aprendizagem' AND learning_level BETWEEN 1 AND 5)
        OR (status <> 'aprendizagem' AND learning_level IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories (updated_at DESC);
    CREATE INDEX IF NOT EXISTS memories_status_idx ON memories (status);
  `);
  await seedMemories(app.pool);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  // Listas para os selects de escopo.
  app.get('/api/memories/meta', guard(async () => {
    const projects = await app.pool.query('SELECT id, name FROM projects ORDER BY name');
    const users = await app.pool.query('SELECT id, name FROM users ORDER BY name');
    return { projects: projects.rows, users: users.rows };
  }));

  // Lista filtrável, ordenada por importância e depois por atualização.
  app.get<{ Querystring: { q?: string; status?: string; scope?: string } }>(
    '/api/memories',
    guard(async (req) => {
      const { q, status, scope } = (req.query ?? {}) as { q?: string; status?: string; scope?: string };
      const where: string[] = [];
      const params: unknown[] = [];

      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        const p = `$${params.length}`;
        where.push(`(m.title ILIKE ${p} OR m.summary ILIKE ${p} OR EXISTS (SELECT 1 FROM unnest(m.keywords) k WHERE k ILIKE ${p}))`);
      }
      if (status === 'deus' || status === 'aprendizagem' || status === 'rascunho') {
        params.push(status);
        where.push(`m.status = $${params.length}`);
      }
      if (scope === 'universais') where.push('m.scope_project_id IS NULL AND m.scope_user_id IS NULL');
      else if (scope === 'projeto') where.push('m.scope_project_id IS NOT NULL');
      else if (scope === 'usuario') where.push('m.scope_user_id IS NOT NULL');

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await app.pool.query(
        `SELECT m.id, m.code, m.title, m.summary, m.status, m.learning_level, m.keywords,
                m.scope_project_id, m.scope_user_id, p.name AS project_name, u.name AS user_name,
                m.created_at, m.last_accessed_at, m.updated_at
           FROM memories m
           LEFT JOIN projects p ON p.id = m.scope_project_id
           LEFT JOIN users u ON u.id = m.scope_user_id
           ${whereSql}
           ORDER BY m.updated_at DESC`,
        params,
      );
      // Ordena por importância na aplicação para usar exatamente o mesmo helper da UI.
      const list = rows
        .map((r) => ({ ...r, _rank: importanceRank(r.status, r.learning_level) }))
        .sort((a, b) => b._rank - a._rank || +new Date(b.updated_at) - +new Date(a.updated_at))
        .map(({ _rank, updated_at, ...rest }) => rest);
      return { memories: list };
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

  // Cria (title obrigatório; valida tudo; gera o código).
  app.post<{ Body: Record<string, unknown> }>(
    '/api/memories',
    guard(async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const title = reqTitle(b.title);
      const status: Status = b.status === undefined ? 'rascunho' : normalizeStatus(b.status);
      const learning_level = normalizeLearningLevel(status, b.learning_level);
      const summary = normalizeSummary(b.summary);
      const keywords = normalizeKeywords(b.keywords);
      const body_md = typeof b.body_md === 'string' ? b.body_md : '';
      const rewritable = b.rewritable === undefined ? true : Boolean(b.rewritable);
      const scope_project_id = normalizeScopeId(b.scope_project_id);
      const scope_user_id = normalizeScopeId(b.scope_user_id);
      const code = await uniqueCode(app, typeof b.code === 'string' && b.code.trim() ? b.code : title);

      const { rows } = await app.pool.query(
        `INSERT INTO memories (code, title, summary, body_md, status, learning_level, rewritable, keywords, scope_project_id, scope_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [code, title, summary, body_md, status, learning_level, rewritable, keywords, scope_project_id, scope_user_id],
      );
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
        `SELECT title, summary, body_md, status, learning_level, rewritable, keywords, scope_project_id, scope_user_id FROM memories WHERE id = $1`,
        [id],
      );
      if (!cur.rows[0]) return reply.code(404).send({ error: 'memória não encontrada' });
      const c = cur.rows[0];
      const b = (req.body ?? {}) as Record<string, unknown>;

      const title = b.title === undefined ? c.title : reqTitle(b.title);
      const status: Status = b.status === undefined ? c.status : normalizeStatus(b.status);
      // Se o status mudou e o nível não veio, recalcula a partir do enviado (ou zera fora de aprendizagem).
      const rawLevel = b.learning_level === undefined ? (b.status === undefined ? c.learning_level : null) : b.learning_level;
      const learning_level = normalizeLearningLevel(status, rawLevel);
      const summary = b.summary === undefined ? c.summary : normalizeSummary(b.summary);
      const keywords = b.keywords === undefined ? c.keywords : normalizeKeywords(b.keywords);
      const rewritable = b.rewritable === undefined ? c.rewritable : Boolean(b.rewritable);
      const scope_project_id = b.scope_project_id === undefined ? c.scope_project_id : normalizeScopeId(b.scope_project_id);
      const scope_user_id = b.scope_user_id === undefined ? c.scope_user_id : normalizeScopeId(b.scope_user_id);
      const body_md = b.body_md === undefined ? c.body_md : typeof b.body_md === 'string' ? b.body_md : '';
      const bodyChanged = b.body_md !== undefined && body_md !== c.body_md;

      await app.pool.query(
        `UPDATE memories SET title=$2, summary=$3, body_md=$4, status=$5, learning_level=$6, rewritable=$7,
                keywords=$8, scope_project_id=$9, scope_user_id=$10, updated_at=now()
                ${bodyChanged ? ', last_rewritten_at=now()' : ''}
          WHERE id=$1`,
        [id, title, summary, body_md, status, learning_level, rewritable, keywords, scope_project_id, scope_user_id],
      );
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
