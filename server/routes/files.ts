import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitStatus, gitTimeline } from '../files/git.js';
import {
  isBinary, isHeavy, isInside, joinRel, mimeOf, relativeInside, resolveInside, sortEntries,
  validateName, validateRelName, type Entry,
} from '../files/util.js';

/**
 * Página Arquivos: explorer sobre as pastas dos projetos (tabela `projects`).
 * Toda entrada de caminho passa por `resolveInside` (sem `..`, sem absoluto) e depois por
 * realpath, para symlink apontando para fora da raiz também ser recusado.
 */

const MAX_TEXT = 2 * 1024 * 1024;       // leitura como texto
const MAX_RAW = 64 * 1024 * 1024;       // /raw (imagens etc.)
const MAX_DIR = 5000;                   // entradas por pasta
const SEARCH_MAX_WALK = 20_000;
const SEARCH_MAX_HITS = 200;

type Root = { id: number; slug: string; name: string; path: string };

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (m: string) => new HttpError(400, m);

function fsError(e: unknown): HttpError | null {
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOENT': return new HttpError(404, 'não existe');
    case 'EEXIST': return new HttpError(409, 'já existe um item com esse nome');
    case 'ENOTEMPTY': return new HttpError(409, 'pasta não está vazia');
    case 'EACCES': case 'EPERM': return new HttpError(403, 'sem permissão no disco');
    case 'ENOTDIR': return new HttpError(400, 'não é uma pasta');
    case 'EISDIR': return new HttpError(400, 'é uma pasta');
    default: return null;
  }
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const guard = (fn: Handler): Handler => async (req, reply) => {
  try {
    return await fn(req, reply);
  } catch (e) {
    const he = e instanceof HttpError ? e : fsError(e);
    if (he) return reply.code(he.status).send({ error: he.message });
    throw e;
  }
};

const str = (v: unknown, name: string, allowEmpty = false): string => {
  if (typeof v !== 'string') throw bad(`${name} inválido`);
  if (!allowEmpty && !v) throw bad(`${name} vazio`);
  return v;
};

export async function filesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  async function roots(): Promise<Root[]> {
    const { rows } = await app.pool.query<Root>('SELECT id, slug, name, path FROM projects ORDER BY id');
    return rows;
  }

  async function rootOf(idRaw: unknown): Promise<Root & { real: string }> {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) throw bad('root inválido');
    const r = (await roots()).find(x => x.id === id);
    if (!r) throw new HttpError(404, 'projeto não encontrado');
    const real = await realpath(r.path).catch(() => null);
    if (!real) throw new HttpError(404, `pasta do projeto não existe no disco (${r.path})`);
    return { ...r, real };
  }

  type Target = {
    root: Root & { real: string };
    rel: string;
    /** Caminho real (symlinks resolvidos): usado para ler/escrever/listar. */
    abs: string;
    /** Caminho lógico (o link em si, não o alvo): usado para renomear/mover/excluir. */
    logical: string;
    exists: boolean;
  };

  /**
   * Resolve `rel` dentro da raiz. `abs` é o caminho real (symlinks resolvidos) quando o item
   * existe; para item novo, é o realpath da pasta-mãe + nome. Fora da raiz → 403.
   */
  async function target(root: Root & { real: string }, relRaw: unknown, opts: { mustExist?: boolean } = {}): Promise<Target> {
    const rel = str(relRaw, 'path', true).replace(/^\.\/+/, '').replace(/\/+$/, '');
    const abs0 = resolveInside(root.real, rel);
    if (abs0 === null) throw bad('caminho fora do projeto');
    let abs: string;
    let exists = true;
    try {
      abs = await realpath(abs0);
    } catch {
      exists = false;
      if (opts.mustExist) throw new HttpError(404, 'não existe');
      const parentReal = await realpath(path.dirname(abs0)).catch(() => null);
      if (!parentReal) throw new HttpError(404, 'pasta não existe');
      abs = path.join(parentReal, path.basename(abs0));
    }
    if (!isInside(root.real, abs)) throw new HttpError(403, 'caminho aponta para fora do projeto');
    return { root, rel: relativeInside(root.real, abs0), abs, logical: abs0, exists };
  }

  const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;
  const b = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/files/roots', guard(async () => {
    const rs = await roots();
    const out = await Promise.all(rs.map(async r => {
      const st = await stat(r.path).catch(() => null);
      const git = st ? await access(path.join(r.path, '.git')).then(() => true, () => false) : false;
      return { id: r.id, slug: r.slug, name: r.name, path: r.path, exists: !!st?.isDirectory(), git };
    }));
    return { roots: out };
  }));

  app.get('/api/files/list', guard(async (req) => {
    const { root, rel, abs } = await target(await rootOf(q(req).root), q(req).path ?? '', { mustExist: true });
    const dirents = await readdir(abs, { withFileTypes: true });
    const truncated = dirents.length > MAX_DIR;
    const entries: Entry[] = [];
    for (const d of dirents.slice(0, MAX_DIR)) {
      const full = path.join(abs, d.name);
      const ls = await lstat(full).catch(() => null);
      if (!ls) continue;
      let type: Entry['type'] = ls.isDirectory() ? 'dir' : ls.isSymbolicLink() ? 'symlink' : 'file';
      let tgt: Entry['target'];
      if (type === 'symlink') {
        const s = await stat(full).catch(() => null);
        tgt = s ? (s.isDirectory() ? 'dir' : 'file') : null;
      }
      const e: Entry = { name: d.name, type, size: ls.size, mtime: Math.round(ls.mtimeMs) };
      if (type === 'symlink') e.target = tgt;
      if (type === 'dir' && isHeavy(d.name)) e.heavy = true;
      entries.push(e);
    }
    return { root: root.id, path: rel, entries: sortEntries(entries), truncated };
  }));

  app.get('/api/files/read', guard(async (req) => {
    const { rel, abs } = await target(await rootOf(q(req).root), q(req).path, { mustExist: true });
    const st = await stat(abs);
    if (st.isDirectory()) throw bad('é uma pasta');
    const base = { path: rel, size: st.size, mtime: Math.round(st.mtimeMs) };
    const fh = await open(abs, 'r');
    try {
      const head = Buffer.alloc(Math.min(8000, st.size));
      if (head.length) await fh.read(head, 0, head.length, 0);
      if (isBinary(rel, head)) return { ...base, binary: true };
      if (st.size > MAX_TEXT) return { ...base, binary: false, large: true };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const { bytesRead } = await fh.read(buf, off, st.size - off, off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      return { ...base, binary: false, content: buf.subarray(0, off).toString('utf8') };
    } finally {
      await fh.close();
    }
  }));

  app.get('/api/files/raw', guard(async (req, reply) => {
    const { rel, abs } = await target(await rootOf(q(req).root), q(req).path, { mustExist: true });
    const st = await stat(abs);
    if (st.isDirectory()) throw bad('é uma pasta');
    if (st.size > MAX_RAW) throw new HttpError(413, 'arquivo grande demais');
    const mime = mimeOf(rel);
    reply.type(mime === 'text/html' ? 'text/plain; charset=utf-8' : mime);
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', 'inline');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(createReadStream(abs));
  }));

  app.put('/api/files/write', guard(async (req, reply) => {
    const body = b(req);
    const { rel, abs, exists } = await target(await rootOf(body.root), body.path);
    const content = str(body.content, 'content', true);
    if (Buffer.byteLength(content) > MAX_TEXT * 4) throw new HttpError(413, 'conteúdo grande demais');
    if (exists) {
      const st = await stat(abs);
      if (st.isDirectory()) throw bad('é uma pasta');
      const expected = body.expected_mtime;
      if (expected !== undefined && expected !== null) {
        const exp = Number(expected);
        if (Number.isFinite(exp) && Math.round(st.mtimeMs) !== Math.round(exp)) {
          return reply.code(409).send({ error: 'o arquivo mudou no disco desde que foi aberto', mtime: Math.round(st.mtimeMs) });
        }
      }
    }
    await writeFile(abs, content, 'utf8');
    const st = await stat(abs);
    return { path: rel, size: st.size, mtime: Math.round(st.mtimeMs) };
  }));

  app.post('/api/files/mkdir', guard(async (req) => {
    const body = b(req);
    const root = await rootOf(body.root);
    const relIn = str(body.path, 'path');
    const err = validateRelName(relIn);
    if (err) throw bad(err);
    const { rel, abs, exists } = await target(root, relIn);
    if (exists) throw new HttpError(409, 'já existe um item com esse nome');
    await mkdir(abs, { recursive: true });
    return { path: rel };
  }));

  app.post('/api/files/create', guard(async (req) => {
    const body = b(req);
    const root = await rootOf(body.root);
    const relIn = str(body.path, 'path');
    const err = validateRelName(relIn);
    if (err) throw bad(err);
    const parentRel = path.posix.dirname(relIn.replace(/\\/g, '/'));
    if (parentRel && parentRel !== '.') {
      const parent = await target(root, parentRel);
      if (!parent.exists) await mkdir(parent.abs, { recursive: true });
    }
    const { rel, abs } = await target(root, relIn);
    await writeFile(abs, '', { flag: 'wx' });
    return { path: rel };
  }));

  /** Renomear (`to` = caminho relativo completo do novo nome) e mover (`to` = pasta de destino). */
  async function relocate(root: Root & { real: string }, fromRel: unknown, toRel: unknown, mode: 'rename' | 'move') {
    const from = await target(root, fromRel, { mustExist: true });
    if (!from.rel) throw new HttpError(403, 'não dá para mexer na raiz do projeto');
    if (path.basename(from.rel) === '.git') throw new HttpError(403, '.git é protegido');
    let destRel: string;
    if (mode === 'rename') {
      destRel = str(toRel, 'to').replace(/^\.\/+/, '').replace(/\/+$/, '');
      const err = validateName(path.posix.basename(destRel));
      if (err) throw bad(err);
    } else {
      const dir = await target(root, toRel ?? '', { mustExist: true });
      if (!(await stat(dir.abs)).isDirectory()) throw bad('destino não é uma pasta');
      destRel = joinRel(dir.rel, path.basename(from.rel));
    }
    const dest = await target(root, destRel);
    if (dest.abs === from.abs) return { from: from.rel, to: dest.rel, unchanged: true };
    if (isInside(from.abs, dest.abs)) throw bad('não dá para mover uma pasta para dentro dela mesma');
    // Só o caso de mudar apenas a caixa do nome (macOS) pode "existir" e ainda ser válido.
    if (dest.exists && dest.abs.toLowerCase() !== from.abs.toLowerCase()) {
      throw new HttpError(409, 'já existe um item com esse nome no destino');
    }
    await rename(from.logical, dest.logical);
    return { from: from.rel, to: dest.rel };
  }

  app.post('/api/files/rename', guard(async (req) => {
    const body = b(req);
    return relocate(await rootOf(body.root), body.from, body.to, 'rename');
  }));

  app.post('/api/files/move', guard(async (req) => {
    const body = b(req);
    return relocate(await rootOf(body.root), body.from, body.to, 'move');
  }));

  app.post('/api/files/delete', guard(async (req) => {
    const body = b(req);
    const { rel, logical } = await target(await rootOf(body.root), body.path, { mustExist: true });
    if (!rel) throw new HttpError(403, 'não dá para excluir a raiz do projeto');
    if (rel.split('/').includes('.git')) throw new HttpError(403, '.git é protegido');
    const ls = await lstat(logical);
    if (ls.isSymbolicLink()) await rm(logical);            // remove o link, nunca o alvo
    else await rm(logical, { recursive: true, force: false });
    return { ok: true, path: rel };
  }));

  app.get('/api/files/git-status', guard(async (req) => {
    const root = await rootOf(q(req).root);
    return gitStatus(root.real);
  }));

  app.get('/api/files/timeline', guard(async (req) => {
    const root = await rootOf(q(req).root);
    const { rel } = await target(root, q(req).path, { mustExist: true });
    return gitTimeline(root.real, rel || '.');
  }));

  app.get('/api/files/search', guard(async (req) => {
    const root = await rootOf(q(req).root);
    const needle = str(q(req).q, 'q').trim().toLowerCase();
    if (needle.length < 1) throw bad('q vazio');
    const matches: { path: string; type: 'file' | 'dir' }[] = [];
    let walked = 0;
    let truncated = false;
    const queue: string[] = [''];
    while (queue.length && !truncated) {
      const dirRel = queue.shift()!;
      const dirAbs = path.join(root.real, dirRel);
      const dirents = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (++walked > SEARCH_MAX_WALK) { truncated = true; break; }
        const rel = joinRel(dirRel, d.name);
        const isDir = d.isDirectory();
        if (d.name.toLowerCase().includes(needle)) {
          matches.push({ path: rel, type: isDir ? 'dir' : 'file' });
          if (matches.length >= SEARCH_MAX_HITS) { truncated = true; break; }
        }
        if (isDir && !isHeavy(d.name)) queue.push(rel);
      }
    }
    matches.sort((a, c) => a.path.length - c.path.length || a.path.localeCompare(c.path));
    return { matches, truncated, walked };
  }));
}
