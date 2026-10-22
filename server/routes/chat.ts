import type { FastifyInstance } from 'fastify';
import { responderNoChat } from '../claude/chatAgent.js';

// Chat entre pessoas do painel: canal "equipe" (todo mundo), uma conversa por par de pessoas
// ('dm:<id menor>-<id maior>') e uma conversa com o Orion ('dm:orion-<id>'). Sem WebSocket: time
// pequeno, polling resolve. O Orion responde de forma síncrona dentro do próprio POST (decisão do
// conclave de 22/10/2026): no canal equipe só quando mencionado ("orion"/"@orion"), na DM com ele
// sempre — nunca nas DMs entre duas pessoas.

const ORION_NOME = 'Orion';

function dmChannel(a: number, b: number): string {
  return `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
}
function dmOrionChannel(userId: number): string {
  return `dm:orion-${userId}`;
}

/** Garante que o canal existe de verdade e que esta pessoa pode lê-lo/escrever nele. */
function checkChannel(channel: string, userId: number): void {
  if (channel === 'equipe') return;
  if (channel === dmOrionChannel(userId)) return;
  const m = /^dm:(\d+)-(\d+)$/.exec(channel);
  if (!m || (Number(m[1]) !== userId && Number(m[2]) !== userId)) {
    throw Object.assign(new Error('canal inválido'), { statusCode: 400 });
  }
}

function orionDeveResponder(channel: string, userId: number, texto: string): boolean {
  if (channel === dmOrionChannel(userId)) return true;
  if (channel === 'equipe') return /\borion\b/i.test(texto);
  return false;
}

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.get('/api/chat/conversas', async (req) => {
    const me = req.user!.id;
    const { rows: pessoas } = await app.pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE id != $1 ORDER BY name', [me]);
    const canais = ['equipe', dmOrionChannel(me), ...pessoas.map((p) => dmChannel(me, p.id))];
    const { rows: unreadRows } = await app.pool.query<{ channel: string; unread: string }>(
      `SELECT m.channel, count(*) AS unread
         FROM chat_messages m
         LEFT JOIN chat_reads r ON r.channel = m.channel AND r.user_id = $1
        WHERE m.channel = ANY($2) AND coalesce(m.from_user_id, -1) != $1 AND m.id > coalesce(r.last_read_id, 0)
        GROUP BY m.channel`, [me, canais]);
    const unreadByChannel = new Map(unreadRows.map((r) => [r.channel, Number(r.unread)]));
    return {
      conversas: [
        { channel: dmOrionChannel(me), nome: ORION_NOME, orion: true, unread: unreadByChannel.get(dmOrionChannel(me)) ?? 0 },
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
      `SELECT m.id, m.from_user_id, m.from_agent, coalesce(u.name, $2) AS from_name, m.text, m.created_at
         FROM chat_messages m LEFT JOIN users u ON u.id = m.from_user_id
        WHERE m.channel = $1 ORDER BY m.id ASC LIMIT 300`, [req.params.channel, ORION_NOME]);
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
    const channel = req.params.channel;
    const { rows } = await app.pool.query(
      `INSERT INTO chat_messages (channel, from_user_id, text) VALUES ($1, $2, $3)
       RETURNING id, from_user_id, false AS from_agent, $4::text AS from_name, text, created_at`,
      [channel, req.user!.id, text, req.user!.name]);
    const mensagens = [rows[0]];

    if (orionDeveResponder(channel, req.user!.id, text)) {
      const { rows: historicoRows } = await app.pool.query(
        `SELECT m.from_agent, coalesce(u.name, $2) AS from_name, m.text
           FROM chat_messages m LEFT JOIN users u ON u.id = m.from_user_id
          WHERE m.channel = $1 ORDER BY m.id DESC LIMIT 10`, [channel, ORION_NOME]);
      const historico = historicoRows.reverse();
      const resposta = await responderNoChat({
        pool: app.pool, repoDir: app.repoDir, autor: req.user!.name, texto: text, historico,
      }).catch((e) => `Deu erro ao tentar responder: ${(e as Error).message}`);
      const { rows: orionRows } = await app.pool.query(
        `INSERT INTO chat_messages (channel, from_user_id, from_agent, text) VALUES ($1, NULL, true, $2)
         RETURNING id, from_user_id, from_agent, $3::text AS from_name, text, created_at`,
        [channel, resposta, ORION_NOME]);
      mensagens.push(orionRows[0]);
    }
    return { mensagens };
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
