import type { FastifyInstance } from 'fastify';
import { KEYS, getSetting } from '../settings.js';
import { gerarOuAjustarDesign, limparGerandoPreso, type DesignQuery } from '../design/gerar.js';

export function podeApagar(user: { id: number; role: string }, design: { user_id: number }): boolean {
  return user.role === 'owner' || user.id === design.user_id;
}

/**
 * Marca 'gerando' só se não estiver gerando já (UPDATE atômico, sem SELECT-depois-UPDATE): duas
 * chamadas concorrentes em POST /api/design/:id/ajustar não disparam duas gerações na mesma linha.
 */
export async function marcarGerandoSeLivre(query: DesignQuery, id: number): Promise<'ok' | 'ocupado' | 'inexistente'> {
  const upd = await query("UPDATE designs SET status = 'gerando', updated_at = now() WHERE id = $1 AND status <> 'gerando' RETURNING id", [id]);
  if (upd.rows[0]) return 'ok';
  const { rows } = await query('SELECT 1 FROM designs WHERE id = $1', [id]);
  return rows[0] ? 'ocupado' : 'inexistente';
}

export async function designRoutes(app: FastifyInstance) {
  const query: DesignQuery = (sql, params) => app.pool.query(sql, params as any[]);

  // Reinício no meio de uma geração (todo deploy reinicia o Orion) não pode deixar a linha presa
  // em 'gerando' para sempre.
  await limparGerandoPreso(query);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.post<{ Body: { tema?: string } }>('/api/design', async (req, reply) => {
    const tema = (req.body?.tema ?? '').trim();
    if (!tema) return reply.code(400).send({ error: 'informe o tema' });
    const { rows } = await app.pool.query(
      'INSERT INTO designs (user_id, titulo, tema) VALUES ($1, $2, $3) RETURNING id',
      [req.user!.id, tema.slice(0, 60), tema],
    );
    const id = rows[0].id;
    void getSetting(app.pool, KEYS.claudeToken)
      .then(tk => gerarOuAjustarDesign(query, id, null, tk))
      .catch(e => app.log.error(e, 'falha ao disparar geração do design'));
    return { id };
  });

  app.get('/api/design', async () => {
    const { rows } = await app.pool.query(
      `SELECT d.id, d.titulo, d.status, d.created_at, u.name AS autor
         FROM designs d JOIN users u ON u.id = d.user_id
        ORDER BY d.created_at DESC`);
    return { designs: rows };
  });

  app.get<{ Params: { id: string } }>('/api/design/:id', async (req, reply) => {
    const { rows } = await app.pool.query(
      `SELECT d.id, d.titulo, d.tema, d.html, d.status, d.erro, d.historico, d.created_at, d.updated_at, d.user_id, u.name AS autor
         FROM designs d JOIN users u ON u.id = d.user_id
        WHERE d.id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'não existe' });
    return rows[0];
  });

  app.post<{ Params: { id: string }; Body: { instrucao?: string } }>('/api/design/:id/ajustar', async (req, reply) => {
    const id = Number(req.params.id);
    const instrucao = (req.body?.instrucao ?? '').trim();
    if (!instrucao) return reply.code(400).send({ error: 'informe a instrução' });
    const estado = await marcarGerandoSeLivre(query, id);
    if (estado === 'inexistente') return reply.code(404).send({ error: 'não existe' });
    if (estado === 'ocupado') return reply.code(409).send({ error: 'já está gerando' });
    const tk = await getSetting(app.pool, KEYS.claudeToken);
    void gerarOuAjustarDesign(query, id, instrucao, tk).catch(e => app.log.error(e, 'falha ao disparar ajuste do design'));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/design/:id', async (req, reply) => {
    const { rows } = await app.pool.query('SELECT user_id FROM designs WHERE id = $1', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'não existe' });
    if (!podeApagar(req.user!, rows[0])) return reply.code(403).send({ error: 'só quem criou ou o admin' });
    await app.pool.query('DELETE FROM designs WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // Content-Security-Policy "sandbox" isola esta resposta numa origem opaca mesmo se alguém abrir
  // a URL direto (fora do <iframe sandbox>): sem isso, HTML gerado por IA rodaria com a sessão de
  // quem clicar, na origem do orion.bayerl.cloud (cookie, /senhas, tudo).
  app.get<{ Params: { id: string } }>('/api/design/:id/preview', async (req, reply) => {
    const { rows } = await app.pool.query('SELECT html FROM designs WHERE id = $1', [req.params.id]);
    if (!rows[0]?.html) return reply.code(404).send({ error: 'sem preview' });
    reply.header('Content-Security-Policy', 'sandbox allow-scripts');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type('text/html').send(rows[0].html);
  });
}
