import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mkdir } from 'node:fs/promises';
import { createWorktree, integrate, removeWorktree, runTests, worktreeDiff } from '../tasks/git.js';
import {
  TASK_STATUSES,
  integrationVerdict,
  taskBranch,
  verdictIsDone,
  worktreePath,
  worktreesRoot,
  type TaskStatus,
} from '../tasks/util.js';

// Kanban de Tarefas: cada tarefa que entra em "fazendo" ganha um git worktree numa branch própria,
// e o integrador faz merge + testes de volta na base. A tabela nasce aqui (sem migração).

type ProjectRow = { id: number; slug: string; name: string; path: string; default_branch: string };

const TASK_SELECT = `
  SELECT t.*, a.name AS assignee_name, p.name AS project_name, p.slug AS project_slug
    FROM tasks t
    LEFT JOIN users a ON a.id = t.assignee_id
    JOIN projects p ON p.id = t.project_id`;

// Ordem das colunas do quadro para o ORDER BY.
const STATUS_ORDER = `CASE t.status
  WHEN 'backlog' THEN 0 WHEN 'fazendo' THEN 1 WHEN 'revisao' THEN 2 WHEN 'feito' THEN 3 ELSE 4 END`;

class Bad extends Error {}

// Genérico para preservar os tipos de Params/Querystring/Body de cada rota (ver memories.ts).
function guard<Req extends FastifyRequest>(
  fn: (req: Req, reply: FastifyReply) => Promise<unknown>,
): (req: Req, reply: FastifyReply) => Promise<unknown> {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof Bad) return reply.code(400).send({ error: e.message });
      const code = (e as { code?: string })?.code;
      if (code === '23503') return reply.code(400).send({ error: 'projeto ou usuário não existe' });
      if (code === '23514') return reply.code(400).send({ error: 'status inválido' });
      throw e;
    }
  };
}

function intOf(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Bad(`${name} inválido`);
  return n;
}
function optId(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Bad('id inválido');
  return n;
}
function reqStr(v: unknown, name: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new Bad(`${name} é obrigatório`);
  return s;
}
function statusOf(v: unknown): TaskStatus {
  if (typeof v === 'string' && (TASK_STATUSES as string[]).includes(v)) return v as TaskStatus;
  throw new Bad('status inválido');
}

export async function tasksRoutes(app: FastifyInstance) {
  // A tabela nasce do próprio plugin.
  await app.pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','fazendo','revisao','feito','arquivada')),
      assignee_id INT REFERENCES users(id),
      created_by INT NOT NULL REFERENCES users(id),
      branch TEXT,
      worktree_path TEXT,
      integration_status TEXT CHECK (integration_status IN ('pendente','integrando','integrada','conflito','testes_falharam')),
      integration_log TEXT,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks (project_id, status, position);
    CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks (updated_at DESC);
  `);

  // Garante o diretório-raiz dos worktrees; se falhar, só registra e segue (a criação avisará).
  await mkdir(worktreesRoot(), { recursive: true }).catch((err) =>
    app.log.warn({ err, dir: worktreesRoot() }, 'não consegui criar WORKTREES_DIR'),
  );

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  // Projeto com o default_branch lido de forma defensiva (a coluna pode não existir neste schema).
  async function projectOf(id: number): Promise<ProjectRow | null> {
    const { rows } = await app.pool.query('SELECT id, slug, name, path FROM projects WHERE id = $1', [id]);
    if (!rows[0]) return null;
    let default_branch = 'main';
    try {
      const r = await app.pool.query('SELECT default_branch FROM projects WHERE id = $1', [id]);
      if (r.rows[0]?.default_branch) default_branch = String(r.rows[0].default_branch);
    } catch {
      /* schema sem a coluna default_branch: fica em 'main' */
    }
    return { ...(rows[0] as Omit<ProjectRow, 'default_branch'>), default_branch };
  }

  async function taskById(id: number) {
    const { rows } = await app.pool.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    return rows[0] ?? null;
  }

  // Lista de tarefas de um projeto (ou todas), agrupável por coluna no cliente.
  app.get<{ Querystring: { project_id?: string } }>(
    '/api/tasks',
    guard(async (req) => {
      const pid = req.query?.project_id;
      const params: unknown[] = [];
      let where = '';
      if (pid !== undefined && pid !== '') {
        params.push(intOf(pid, 'project_id'));
        where = 'WHERE t.project_id = $1';
      }
      const { rows } = await app.pool.query(
        `${TASK_SELECT} ${where} ORDER BY ${STATUS_ORDER}, t.position, t.id`,
        params,
      );
      return { tasks: rows };
    }),
  );

  // Projetos para o seletor + usuários para o campo de responsável.
  app.get('/api/tasks/projects', guard(async () => {
    const projects = await app.pool.query('SELECT id, slug, name FROM projects ORDER BY name');
    const users = await app.pool.query('SELECT id, name FROM users ORDER BY name');
    return { projects: projects.rows, users: users.rows };
  }));

  // Cria a tarefa no backlog, no fim da coluna.
  app.post<{ Body: Record<string, unknown> }>(
    '/api/tasks',
    guard(async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const project_id = intOf(b.project_id, 'project_id');
      const title = reqStr(b.title, 'título');
      const goal = typeof b.goal === 'string' ? b.goal : '';
      const assignee_id = optId(b.assignee_id);
      const pos = await app.pool.query(
        `SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE project_id = $1 AND status = 'backlog'`,
        [project_id],
      );
      const { rows } = await app.pool.query(
        `INSERT INTO tasks (project_id, title, goal, assignee_id, created_by, position)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [project_id, title, goal, assignee_id, req.user!.id, pos.rows[0].n],
      );
      return reply.code(201).send({ task: await taskById(rows[0].id) });
    }),
  );

  // Atualiza campos; ao entrar em "fazendo" sem worktree, cria a branch+worktree.
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tasks/:id',
    guard(async (req, reply) => {
      const id = intOf(req.params.id, 'id');
      const cur = await taskById(id);
      if (!cur) return reply.code(404).send({ error: 'tarefa não encontrada' });
      const b = (req.body ?? {}) as Record<string, unknown>;

      const title = b.title === undefined ? cur.title : reqStr(b.title, 'título');
      const goal = b.goal === undefined ? cur.goal : typeof b.goal === 'string' ? b.goal : '';
      const status: TaskStatus = b.status === undefined ? cur.status : statusOf(b.status);
      const assignee_id = b.assignee_id === undefined ? cur.assignee_id : optId(b.assignee_id);
      const position = b.position === undefined ? cur.position : Number.isFinite(Number(b.position)) ? Math.trunc(Number(b.position)) : cur.position;

      let branch: string | null = cur.branch;
      let worktree_path: string | null = cur.worktree_path;
      let integration_status: string | null = cur.integration_status;
      let warning: string | undefined;

      // Entrando em "fazendo" e ainda sem worktree: cria branch + worktree.
      if (status === 'fazendo' && !cur.worktree_path) {
        const proj = await projectOf(cur.project_id);
        if (!proj) {
          warning = 'projeto da tarefa não encontrado; worktree não criado';
        } else {
          const br = taskBranch(title, id);
          const wt = worktreePath(worktreesRoot(), proj.slug, id);
          if (!wt) {
            warning = 'não consegui montar o caminho do worktree';
          } else {
            const r = await createWorktree(proj.path, br, proj.default_branch || 'main', wt);
            if (r.ok) {
              branch = br;
              worktree_path = r.path;
            } else {
              warning = `worktree não criado: ${r.log}`; // segue sem branch/worktree
            }
          }
        }
      }
      // Ao entrar em revisão sem veredito ainda, marca como pendente de integração.
      if (status === 'revisao' && !integration_status) integration_status = 'pendente';

      await app.pool.query(
        `UPDATE tasks SET title=$2, goal=$3, status=$4, assignee_id=$5, position=$6,
                branch=$7, worktree_path=$8, integration_status=$9, updated_at=now()
          WHERE id=$1`,
        [id, title, goal, status, assignee_id, position, branch, worktree_path, integration_status],
      );
      return { task: await taskById(id), warning };
    }),
  );

  // Integra a branch da tarefa na base e roda os testes. Owner ou responsável.
  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/integrate',
    guard(async (req, reply) => {
      const id = intOf(req.params.id, 'id');
      const cur = await taskById(id);
      if (!cur) return reply.code(404).send({ error: 'tarefa não encontrada' });
      const isOwner = req.user!.role === 'owner';
      if (!isOwner && cur.assignee_id !== req.user!.id) {
        return reply.code(403).send({ error: 'só o admin ou o responsável podem integrar' });
      }
      if (!cur.branch || !cur.worktree_path) {
        return reply.code(400).send({ error: 'a tarefa não tem worktree — mova para "Fazendo" primeiro' });
      }
      const proj = await projectOf(cur.project_id);
      if (!proj) return reply.code(400).send({ error: 'projeto da tarefa não encontrado' });
      const base = proj.default_branch || 'main';

      await app.pool.query(`UPDATE tasks SET integration_status='integrando', updated_at=now() WHERE id=$1`, [id]);

      const merged = await integrate(proj.path, cur.branch, base);
      let testsOk: boolean | null = null;
      let testTail = '';
      if (!merged.conflict && merged.ok) {
        const t = await runTests(cur.worktree_path);
        testsOk = t.skipped ? null : t.ok;
        testTail = t.tail;
      }
      const verdict = integrationVerdict({ conflict: merged.conflict, testsOk });
      const doneOk = merged.ok && verdictIsDone(verdict);
      const log = [merged.log, testTail && `--- testes ---\n${testTail}`].filter(Boolean).join('\n\n');

      await app.pool.query(
        `UPDATE tasks SET integration_status=$2, integration_log=$3,
                status = CASE WHEN $4 THEN 'feito' ELSE status END, updated_at=now()
          WHERE id=$1`,
        [id, verdict, log, doneOk],
      );
      return { task: await taskById(id), integration_status: verdict, conflict: merged.conflict, testsOk, log };
    }),
  );

  // Diff da branch contra a base (stat + diff unificado cortado), para a revisão.
  app.get<{ Params: { id: string } }>(
    '/api/tasks/:id/diff',
    guard(async (req, reply) => {
      const id = intOf(req.params.id, 'id');
      const cur = await taskById(id);
      if (!cur) return reply.code(404).send({ error: 'tarefa não encontrada' });
      if (!cur.worktree_path) return { stat: '', diff: '', truncated: false, warning: 'tarefa sem worktree' };
      const proj = await projectOf(cur.project_id);
      const base = proj?.default_branch || 'main';
      return worktreeDiff(cur.worktree_path, base);
    }),
  );

  // Excluir: só o owner. Remove o worktree em best-effort.
  app.delete<{ Params: { id: string } }>(
    '/api/tasks/:id',
    guard(async (req, reply) => {
      if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin pode excluir tarefas' });
      const id = intOf(req.params.id, 'id');
      const cur = await taskById(id);
      if (!cur) return reply.code(404).send({ error: 'tarefa não encontrada' });
      if (cur.worktree_path) {
        const proj = await projectOf(cur.project_id);
        if (proj) await removeWorktree(proj.path, cur.worktree_path).catch(() => {});
      }
      await app.pool.query('DELETE FROM tasks WHERE id = $1', [id]);
      return { ok: true };
    }),
  );
}
