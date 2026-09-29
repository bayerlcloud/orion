import type { FastifyInstance } from 'fastify';

const KINDS = new Set(['tool', 'skill', 'mcp']);

type ToolBody = { kind?: string; name?: string; description?: string; icon?: string; status?: string; link?: string; details?: string };

function intParam(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function toolsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

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
