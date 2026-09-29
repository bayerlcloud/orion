import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { hashPassword, verifyPassword } from '../auth.js';
import {
  AVATAR_EXTS, extForMime, mimeForExt, sanitizePhone, validName, validSurname, validTheme,
} from '../profile/util.js';

/** Limite do avatar: 5 MB. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Onde ficam os avatares em disco: <AVATAR_DIR>/<user_id>.<ext> (padrão /srv/avatars). */
export function avatarDir(): string {
  return path.resolve(process.env.AVATAR_DIR ?? '/srv/avatars');
}

type Row = {
  id: number; name: string; surname: string | null; email: string;
  phone: string | null; role: string; theme: string; avatar_ext: string | null;
};

export async function profileRoutes(app: FastifyInstance) {
  const dir = avatarDir();
  let writable = true;
  // Colunas de perfil, idempotentes, na subida do plugin (não em migrations.ts).
  await app.pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS surname text;
     ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
     ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_ext text;
     ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'dark';`,
  );
  await mkdir(dir, { recursive: true }).catch((e: NodeJS.ErrnoException) => {
    writable = false;
    app.log.warn(`AVATAR_DIR ${dir} não pôde ser criado: ${e.message}`);
  });

  // @fastify/multipart escopado a este plugin (é fastify-plugin, sobe só até aqui).
  await app.register(multipart, { limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 2 }, throwFileSizeLimit: false });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  const avatarPath = (id: number, ext: string) => path.join(dir, `${id}.${ext}`);

  async function loadRow(id: number): Promise<Row | null> {
    const { rows } = await app.pool.query<Row>(
      'SELECT id, name, surname, email, phone, role, theme, avatar_ext FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async function profileOf(id: number) {
    const r = await loadRow(id);
    if (!r) return null;
    const hasAvatar = !!r.avatar_ext;
    let version = 0;
    if (hasAvatar) {
      const st = await stat(avatarPath(r.id, r.avatar_ext!)).catch(() => null);
      if (st) version = Math.floor(st.mtimeMs);
    }
    return {
      id: r.id, name: r.name, surname: r.surname, email: r.email, phone: r.phone,
      role: r.role, theme: r.theme, has_avatar: hasAvatar,
      avatar_url: hasAvatar ? `/api/profile/avatar/${r.id}?v=${version}` : null,
    };
  }

  /** Remove arquivos de avatar do usuário com extensão diferente de `keep`. */
  async function removeOtherAvatars(id: number, keep: string | null) {
    for (const ext of AVATAR_EXTS) {
      if (ext === keep) continue;
      await unlink(avatarPath(id, ext)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    }
  }

  app.get('/api/profile', async (req, reply) => {
    const p = await profileOf(req.user!.id);
    if (!p) return reply.code(404).send({ error: 'usuário não encontrado' });
    return p;
  });

  app.put<{ Body: Record<string, unknown> }>('/api/profile', async (req, reply) => {
    const body = req.body ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const sets: string[] = [];
    const params: unknown[] = [];
    try {
      if (has('name')) { params.push(validName(body.name)); sets.push(`name = $${params.length}`); }
      if (has('surname')) { params.push(validSurname(body.surname)); sets.push(`surname = $${params.length}`); }
      if (has('phone')) {
        const ph = sanitizePhone(body.phone);
        params.push(ph || null); sets.push(`phone = $${params.length}`);
      }
      if (has('theme')) { params.push(validTheme(body.theme)); sets.push(`theme = $${params.length}`); }
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    if (!sets.length) return reply.code(400).send({ error: 'nada para atualizar' });
    params.push(req.user!.id);
    await app.pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    return profileOf(req.user!.id);
  });

  app.post<{ Body: { current_password?: string; new_password?: string } }>('/api/profile/password', async (req, reply) => {
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    const { rows } = await app.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    const stored = rows[0]?.password_hash;
    if (!stored || !(await verifyPassword(current, stored))) {
      return reply.code(400).send({ error: 'senha atual incorreta' });
    }
    if (next.length < 6) return reply.code(400).send({ error: 'a nova senha precisa de ao menos 6 caracteres' });
    const hash = await hashPassword(next);
    await app.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user!.id]);
    return { ok: true };
  });

  app.post('/api/profile/avatar', async (req, reply) => {
    if (!writable) return reply.code(500).send({ error: 'diretório de avatares indisponível no servidor' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'envie como multipart/form-data' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'nenhuma imagem recebida' });
    const ext = extForMime(part.mimetype);
    if (!ext) {
      part.file.resume();
      return reply.code(400).send({ error: 'formato inválido: use PNG, JPEG, WebP ou GIF' });
    }
    const dest = avatarPath(req.user!.id, ext);
    try {
      await pipeline(part.file, createWriteStream(dest, { flags: 'w' }));
    } catch (e) {
      await unlink(dest).catch(() => {});
      throw e;
    }
    if (part.file.truncated) {
      await unlink(dest).catch(() => {});
      return reply.code(413).send({ error: 'a imagem passa do limite de 5 MB' });
    }
    await removeOtherAvatars(req.user!.id, ext);
    await app.pool.query('UPDATE users SET avatar_ext = $1 WHERE id = $2', [ext, req.user!.id]);
    return { ok: true, avatar_url: `/api/profile/avatar/${req.user!.id}?v=${Date.now()}` };
  });

  app.delete('/api/profile/avatar', async (req) => {
    await removeOtherAvatars(req.user!.id, null);
    await app.pool.query('UPDATE users SET avatar_ext = NULL WHERE id = $1', [req.user!.id]);
    return { ok: true };
  });

  // Avatar pelo nome do prefixo "[Nome]" das mensagens do chat; redireciona para a rota por id.
  app.get<{ Params: { name: string } }>('/api/profile/avatar/by-name/:name', async (req, reply) => {
    const { rows } = await app.pool.query<{ id: number }>(
      'SELECT id FROM users WHERE lower(name) = lower($1) AND avatar_ext IS NOT NULL ORDER BY id LIMIT 1', [req.params.name]);
    if (!rows[0]) return reply.code(404).send({ error: 'sem foto' });
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.redirect(`/api/profile/avatar/${rows[0].id}`);
  });

  // Qualquer usuário logado pode ver o avatar de qualquer um (para a barra lateral).
  app.get<{ Params: { id: string } }>('/api/profile/avatar/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ error: 'sem foto' });
    const row = await loadRow(id);
    if (!row || !row.avatar_ext) return reply.code(404).send({ error: 'sem foto' });
    const file = avatarPath(id, row.avatar_ext);
    const st = await stat(file).catch(() => null);
    if (!st) return reply.code(404).send({ error: 'sem foto' });
    reply.header('Content-Length', st.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=60');
    reply.type(mimeForExt(row.avatar_ext));
    return reply.send(createReadStream(file));
  });
}
