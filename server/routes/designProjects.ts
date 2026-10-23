import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeFilename } from '../driveUtils.js';
import { maxFileBytes } from './drive.js';
import { extrairZip, mimeDeArquivo, projectsDir } from '../design/projetos.js';
import { podeApagar } from './design.js';

/**
 * Autorização reaproveitada de design.ts (mesma regra: autor ou owner) em vez de duplicar uma
 * `podeApagarProjeto` igual — não há lógica nova aqui, só outro domínio usando a mesma checagem.
 */
export async function designProjectsRoutes(app: FastifyInstance) {
  const dir = projectsDir();
  await mkdir(dir, { recursive: true })
    .catch((e: NodeJS.ErrnoException) => app.log.warn(`DESIGN_PROJECTS_DIR ${dir} não pôde ser criado: ${e.message}`));

  await app.register(multipart, {
    limits: { fileSize: maxFileBytes(), files: 50, fields: 10 },
    throwFileSizeLimit: false,
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  async function gravarArquivo(projectId: number, nome: string, dados: Buffer, mime: string) {
    const destino = `${randomUUID()}-${safeFilename(path.basename(nome))}`;
    await writeFile(path.join(dir, destino), dados);
    const { rows } = await app.pool.query<{ id: number; created_at: Date }>(
      'INSERT INTO design_project_files (project_id, nome, caminho_disco, mime, size) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
      [projectId, nome, destino, mime, dados.length]);
    return { id: rows[0].id, nome, mime, size: dados.length, created_at: rows[0].created_at };
  }

  async function projetoDoDono(id: number): Promise<{ user_id: number } | null> {
    const { rows } = await app.pool.query('SELECT user_id FROM design_projects WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  app.post<{ Body: { nome?: string } }>('/api/design/projects', async (req, reply) => {
    const nome = (req.body?.nome ?? '').trim();
    if (!nome) return reply.code(400).send({ error: 'informe o nome' });
    const { rows } = await app.pool.query('INSERT INTO design_projects (user_id, nome) VALUES ($1, $2) RETURNING id', [req.user!.id, nome]);
    return { id: rows[0].id };
  });

  app.get('/api/design/projects', async () => {
    const { rows } = await app.pool.query(
      `SELECT p.id, p.nome, p.created_at, u.name AS autor, COUNT(f.id)::int AS arquivos
         FROM design_projects p JOIN users u ON u.id = p.user_id
         LEFT JOIN design_project_files f ON f.project_id = p.id
        GROUP BY p.id, u.name ORDER BY p.created_at DESC`);
    return { projects: rows };
  });

  app.get<{ Params: { id: string } }>('/api/design/projects/:id', async (req, reply) => {
    const projeto = await projetoDoDono(Number(req.params.id));
    if (!projeto) return reply.code(404).send({ error: 'não existe' });
    const { rows: p } = await app.pool.query(
      `SELECT pr.id, pr.nome, pr.created_at, u.name AS autor
         FROM design_projects pr JOIN users u ON u.id = pr.user_id WHERE pr.id = $1`, [req.params.id]);
    const { rows: arquivos } = await app.pool.query(
      'SELECT id, nome, mime, size, created_at FROM design_project_files WHERE project_id = $1 ORDER BY created_at', [req.params.id]);
    return { ...p[0], arquivos };
  });

  app.post<{ Params: { id: string } }>('/api/design/projects/:id/files', async (req, reply) => {
    const id = Number(req.params.id);
    const projeto = await projetoDoDono(id);
    if (!projeto) return reply.code(404).send({ error: 'não existe' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'envie como multipart/form-data' });
    const gravados: { id: number; nome: string; mime: string; size: number; created_at: Date }[] = [];
    for await (const part of req.files()) {
      const original = (part.filename || '').trim() || 'arquivo';
      const buf = await part.toBuffer();
      if (original.toLowerCase().endsWith('.zip')) {
        for (const entrada of extrairZip(buf)) {
          gravados.push(await gravarArquivo(id, entrada.nome, entrada.dados, mimeDeArquivo(entrada.nome)));
        }
      } else {
        gravados.push(await gravarArquivo(id, original, buf, part.mimetype || 'application/octet-stream'));
      }
    }
    if (!gravados.length) return reply.code(400).send({ error: 'nenhum arquivo recebido' });
    return { arquivos: gravados };
  });

  app.delete<{ Params: { id: string; fileId: string } }>('/api/design/projects/:id/files/:fileId', async (req, reply) => {
    const projeto = await projetoDoDono(Number(req.params.id));
    if (!projeto) return reply.code(404).send({ error: 'não existe' });
    if (!podeApagar(req.user!, projeto)) return reply.code(403).send({ error: 'só quem criou ou o admin' });
    const { rows } = await app.pool.query('SELECT caminho_disco FROM design_project_files WHERE id = $1 AND project_id = $2', [req.params.fileId, req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'arquivo não existe' });
    await unlink(path.join(dir, rows[0].caminho_disco)).catch(() => {});
    await app.pool.query('DELETE FROM design_project_files WHERE id = $1', [req.params.fileId]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/design/projects/:id', async (req, reply) => {
    const projeto = await projetoDoDono(Number(req.params.id));
    if (!projeto) return reply.code(404).send({ error: 'não existe' });
    if (!podeApagar(req.user!, projeto)) return reply.code(403).send({ error: 'só quem criou ou o admin' });
    const { rows } = await app.pool.query('SELECT caminho_disco FROM design_project_files WHERE project_id = $1', [req.params.id]);
    await Promise.all(rows.map(r => unlink(path.join(dir, r.caminho_disco)).catch(() => {})));
    await app.pool.query('DELETE FROM design_projects WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  app.get<{ Params: { id: string; fileId: string } }>('/api/design/projects/:id/files/:fileId/view', async (req, reply) => {
    const { rows } = await app.pool.query('SELECT caminho_disco, mime, nome FROM design_project_files WHERE id = $1 AND project_id = $2', [req.params.fileId, req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'não existe' });
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(rows[0].mime || 'application/octet-stream');
    return reply.send(createReadStream(path.join(dir, rows[0].caminho_disco)));
  });
}
