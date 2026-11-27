/**
 * API das propostas de curadoria da memória (ver server/curador/proposals.ts).
 * GET lista pendentes + últimas 50 decididas; aprovar (só owner) APLICA a mudança server-side,
 * revalidando tudo dentro de uma transação com FOR UPDATE; rejeitar só marca.
 */
import type { FastifyInstance } from 'fastify';
import { ValidationError } from '../memories/util.js';
import { aplicarProposta, ensureCuradoriaTable, type PropostaPayload, type TipoProposta } from '../curador/proposals.js';
import { aplicarRegra, type PayloadRegra } from '../curador/regras.js';

// project_name só existe nas propostas de regra (payload.project_id); nas outras vem null.
const LISTA = `
  SELECT c.id, c.tipo, c.payload, c.status, c.created_at, c.decided_at, c.applied_at,
         u.name AS decided_by_name, pr.name AS project_name
    FROM curadoria_propostas c
    LEFT JOIN users u ON u.id = c.decided_by
    LEFT JOIN projects pr ON c.tipo = 'regra' AND pr.id = (c.payload->>'project_id')::int`;

export async function curadoriaRoutes(app: FastifyInstance) {
  await ensureCuradoriaTable(app.pool);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.get('/api/curadoria', async () => {
    const pend = await app.pool.query(`${LISTA} WHERE c.status = 'pendente' ORDER BY c.created_at ASC`);
    const dec = await app.pool.query(
      `${LISTA} WHERE c.status <> 'pendente' ORDER BY c.decided_at DESC NULLS LAST LIMIT 50`,
    );
    return { pendentes: pend.rows, decididas: dec.rows };
  });

  app.post<{ Params: { id: string } }>('/api/curadoria/:id/aprovar', async (req, reply) => {
    if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin aprova propostas' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id inválido' });

    const client = await app.pool.connect();
    let p: { id: number; tipo: string; payload: unknown; status: string } | undefined;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, tipo, payload, status FROM curadoria_propostas WHERE id = $1 FOR UPDATE`, [id]);
      p = rows[0];
      if (!p) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'proposta não existe' }); }
      if (p.status !== 'pendente') { await client.query('ROLLBACK'); return reply.code(409).send({ error: `proposta já ${p.status}` }); }
      const q = (sql: string, params?: unknown[]) => client.query(sql, params as any[]);
      // Regra proposta pelo detector de erros repetidos: aprovar cria a memória nível 2 do projeto.
      const resultado = p.tipo === 'regra'
        ? await aplicarRegra(q, p.payload as PayloadRegra, req.user!.id)
        : await aplicarProposta(q, { tipo: p.tipo as TipoProposta, payload: p.payload as PropostaPayload });
      await client.query(
        `UPDATE curadoria_propostas SET status = 'aprovada', decided_at = now(), decided_by = $2, applied_at = now() WHERE id = $1`,
        [id, req.user!.id],
      );
      await client.query('COMMIT');
      return { ok: true, resultado };
    } catch (e) {
      await client.query('ROLLBACK');
      if (e instanceof ValidationError) {
        // Regra parecida já existe: a proposta não tem mais o que aprovar, então sai da fila como rejeitada.
        if (p?.tipo === 'regra' && /já existe regra parecida/.test(e.message)) {
          await app.pool.query(
            `UPDATE curadoria_propostas SET status = 'rejeitada', decided_at = now(), decided_by = $2 WHERE id = $1 AND status = 'pendente'`,
            [id, req.user!.id],
          );
        }
        return reply.code(409).send({ error: e.message });
      }
      throw e;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { id: string } }>('/api/curadoria/:id/rejeitar', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id inválido' });
    const { rowCount } = await app.pool.query(
      `UPDATE curadoria_propostas SET status = 'rejeitada', decided_at = now(), decided_by = $2
        WHERE id = $1 AND status = 'pendente'`,
      [id, req.user!.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'proposta não existe ou já foi decidida' });
    return { ok: true };
  });
}
