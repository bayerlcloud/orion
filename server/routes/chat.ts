import type { FastifyInstance } from 'fastify';

// Chat entre pessoas do painel: canal "equipe" (todo mundo) e uma conversa por par de pessoas,
// endereçada por 'dm:<id menor>-<id maior>'. Sem WebSocket: 4 pessoas no time, polling resolve.

function dmChannel(a: number, b: number): string {
  return `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
}

/** Garante que o canal existe de verdade e que esta pessoa pode lê-lo/escrever nele. */
function checkChannel(channel: string, userId: number): void {
  if (channel === 'equipe') return;
  const m = /^dm:(\d+)-(\d+)$/.exec(channel);
  if (!m || (Number(m[1]) !== userId && Number(m[2]) !== userId)) {
    throw Object.assign(new Error('canal inválido'), { statusCode: 400 });
  }
}

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.get('/api/chat/conversas', async (req) => {
    const me = req.user!.id;
    const { rows: pessoas } = await app.pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE id != $1 ORDER BY name', [me]);
    const canais = ['equipe', ...pessoas.map((p) => dmChannel(me, p.id))];
    const { rows: unreadRows } = await app.pool.query<{ channel: string; unread: string }>(
      `SELECT m.channel, count(*) AS unread
         FROM chat_messages m
         LEFT JOIN chat_reads r ON r.channel = m.channel AND r.user_id = $1
        WHERE m.channel = ANY($2) AND m.from_user_id != $1 AND m.id > coalesce(r.last_read_id, 0)
        GROUP BY m.channel`, [me, canais]);
    const unreadByChannel = new Map(unreadRows.map((r) => [r.channel, Number(r.unread)]));
    return {
      conversas: [
        { channel: 'equipe', nome: 'Equipe', unread: unreadByChannel.get('equipe') ?? 0 },
        ...pessoas.map((p) => ({ channel: dmChannel(me, p.id), nome: p.name, unread: unreadByChannel.get(dmChannel(me, p.id)) ?? 0 })),
      ],
    };
  });

  app.get<{ Params: { channel: string } }>('/api/chat/:channel/mensagens', async (req, reply) => {
    try {
      checkChannel(req.params.channel, req.user!.id);
    } catch (e) {
      return reply.code((e as any).statusCode ?? 400).send({ error: (e as Error).message });
    }
    const { rows } = await app.pool.query(
      `SELECT m.id, m.from_user_id, u.name AS from_name, m.text, m.created_at
         FROM chat_messages m JOIN users u ON u.id = m.from_user_id
        WHERE m.channel = $1 ORDER BY m.id ASC LIMIT 300`, [req.params.channel]);
    return { mensagens: rows };
  });

  app.post<{ Params: { channel: string }; Body: { text?: string } }>('/api/chat/:channel/mensagens', async (req, reply) => {
    try {
      checkChannel(req.params.channel, req.user!.id);
    } catch (e) {
      return reply.code((e as any).statusCode ?? 400).send({ error: (e as Error).message });
    }
    const text = (req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'mensagem vazia' });
    const { rows } = await app.pool.query(
      `INSERT INTO chat_messages (channel, from_user_id, text) VALUES ($1, $2, $3)
       RETURNING id, from_user_id, $4::text AS from_name, text, created_at`,
      [req.params.channel, req.user!.id, text, req.user!.name]);
    return { mensagem: rows[0] };
  });

  app.post<{ Params: { channel: string } }>('/api/chat/:channel/lida', async (req, reply) => {
    try {
      checkChannel(req.params.channel, req.user!.id);
    } catch (e) {
      return reply.code((e as any).statusCode ?? 400).send({ error: (e as Error).message });
    }
    await app.pool.query(
      `INSERT INTO chat_reads (user_id, channel, last_read_id)
       VALUES ($1, $2, coalesce((SELECT max(id) FROM chat_messages WHERE channel = $2), 0))
       ON CONFLICT (user_id, channel) DO UPDATE SET last_read_id = excluded.last_read_id`,
      [req.user!.id, req.params.channel]);
    return { ok: true };
  });
}
