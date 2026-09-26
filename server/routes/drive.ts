import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { User } from '../db.js';
import { rename as renameFile } from 'node:fs/promises';
import { safeFilename, displayName } from '../driveUtils.js';

/** Limite por arquivo: 2 GB (ou DRIVE_MAX_BYTES). O upload é em streaming, nunca fica inteiro em memória. */
export function maxFileBytes(): number {
  const n = Number(process.env.DRIVE_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2 * 1024 ** 3;
}

function limiteLegivel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

type Row = {
  id: number; user_id: number; user_name: string; name: string;
  size: string | number; mime: string; path: string; created_at: Date;
};
type DriveFile = Omit<Row, 'size'> & { size: number };

export function driveDir(): string {
  return path.resolve(process.env.DRIVE_DIR ?? '/srv/drive');
}

const toFile = (r: Row): DriveFile => ({ ...r, size: Number(r.size) });

/** Content-Disposition com fallback ASCII e o nome real em UTF-8 (RFC 5987). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const SELECT = `SELECT f.id, f.user_id, u.name AS user_name, f.name, f.size, f.mime, f.path, f.created_at
                  FROM drive_files f JOIN users u ON u.id = f.user_id`;

export async function driveRoutes(app: FastifyInstance) {
  const root = driveDir();
  const MAX = maxFileBytes();
  await mkdir(root, { recursive: true })
    .catch((e: NodeJS.ErrnoException) => app.log.warn(`DRIVE_DIR ${root} não pôde ser criado: ${e.message}`));

  // Escopado a este plugin (o @fastify/multipart é fastify-plugin, sobe só até aqui).
  await app.register(multipart, {
    limits: { fileSize: MAX, files: 50, fields: 10 },
    throwFileSizeLimit: false,
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  /** Só o dono do arquivo ou o admin enxergam; para os demais é como se não existisse. */
  async function findFile(idRaw: string, user: User): Promise<DriveFile | null> {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) return null;
    const { rows } = await app.pool.query<Row>(`${SELECT} WHERE f.id = $1`, [id]);
    const f = rows[0];
    if (!f) return null;
    if (user.role !== 'owner' && f.user_id !== user.id) return null;
    return toFile(f);
  }

  app.get('/api/drive/files', async (req) => {
    const user = req.user!;
    const mine = user.role !== 'owner';
    const params = mine ? [user.id] : [];
    const { rows } = await app.pool.query<Row>(
      `${SELECT} ${mine ? 'WHERE f.user_id = $1' : ''} ORDER BY f.created_at DESC, f.id DESC`, params);
    const usage = await app.pool.query<{ user_id: number; name: string; files: number; total: string }>(
      `SELECT u.id AS user_id, u.name, COUNT(f.id)::int AS files, COALESCE(SUM(f.size), 0)::text AS total
         FROM users u LEFT JOIN drive_files f ON f.user_id = u.id
        ${mine ? 'WHERE u.id = $1' : ''}
        GROUP BY u.id, u.name ORDER BY u.id`, params);
    return {
      files: rows.map(toFile),
      usage: usage.rows.map(r => ({ user_id: r.user_id, name: r.name, files: r.files, total: Number(r.total) })),
      max_bytes: MAX,
      dir: root,
    };
  });

  app.post('/api/drive/upload', async (req, reply) => {
    const user = req.user!;
    if (!req.isMultipart()) return reply.code(400).send({ error: 'envie como multipart/form-data' });
    const dir = path.join(root, String(user.id));
    await mkdir(dir, { recursive: true });
    const saved: DriveFile[] = [];

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
        return reply.code(413).send({ error: `"${original}" passa do limite de ${limiteLegivel(MAX)}`, files: saved });
      }
      const { size } = await stat(dest);
      const mime = part.mimetype || 'application/octet-stream';
      const { rows } = await app.pool.query<{ id: number; created_at: Date }>(
        'INSERT INTO drive_files (user_id, name, size, mime, path) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
        [user.id, original, size, mime, dest]);
      saved.push({ id: rows[0].id, user_id: user.id, user_name: user.name, name: original, size, mime, path: dest, created_at: rows[0].created_at });
    }

    if (!saved.length) return reply.code(400).send({ error: 'nenhum arquivo recebido' });
    return { files: saved };
  });

  app.get<{ Params: { id: string } }>('/api/drive/files/:id/download', async (req, reply) => {
    const f = await findFile(req.params.id, req.user!);
    if (!f) return reply.code(404).send({ error: 'arquivo não encontrado' });
    const st = await stat(f.path).catch(() => null);
    if (!st) return reply.code(410).send({ error: 'arquivo não está mais no disco' });
    reply.header('Content-Disposition', contentDisposition(f.name));
    reply.header('Content-Length', st.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.type(f.mime || 'application/octet-stream');
    return reply.send(createReadStream(f.path));
  });

  // Visualização embutida (miniatura/preview): mesma origem, seguro para <img src>.
  app.get<{ Params: { id: string } }>('/api/drive/files/:id/view', async (req, reply) => {
    const f = await findFile(req.params.id, req.user!);
    if (!f) return reply.code(404).send({ error: 'arquivo não encontrado' });
    const st = await stat(f.path).catch(() => null);
    if (!st) return reply.code(410).send({ error: 'arquivo não está mais no disco' });
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    reply.header('Content-Length', st.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=300');
    reply.type(f.mime || 'application/octet-stream');
    return reply.send(createReadStream(f.path));
  });

  // Renomear no servidor: atualiza o nome de exibição e também o arquivo em disco (mantém o prefixo único).
  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/drive/files/:id/rename', async (req, reply) => {
    const f = await findFile(req.params.id, req.user!);
    if (!f) return reply.code(404).send({ error: 'arquivo não encontrado' });
    const novo = displayName(req.body?.name ?? '');
    if (!novo) return reply.code(400).send({ error: 'nome vazio' });
    const dir = path.dirname(f.path);
    const oldBase = path.basename(f.path);
    const uuidPrefix = /^[0-9a-f-]{36}-/i.test(oldBase) ? oldBase.slice(0, 37) : '';
    const destBase = uuidPrefix + safeFilename(novo);
    const dest = path.join(dir, destBase);
    if (dest !== f.path) { await renameFile(f.path, dest).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
    await app.pool.query('UPDATE drive_files SET name = $2, path = $3 WHERE id = $1', [f.id, novo, dest]);
    return { ok: true, name: novo, path: dest };
  });

  app.delete<{ Params: { id: string } }>('/api/drive/files/:id', async (req, reply) => {
    const f = await findFile(req.params.id, req.user!);
    if (!f) return reply.code(404).send({ error: 'arquivo não encontrado' });
    await unlink(f.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await app.pool.query('DELETE FROM drive_files WHERE id = $1', [f.id]);
    return { ok: true };
  });
}
