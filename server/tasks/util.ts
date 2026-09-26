import path from 'node:path';

// Helpers puros do kanban de Tarefas (sem I/O nem git): nome de branch, caminho do worktree,
// parse do `git worktree list --porcelain` e o veredito da integração.
// Cobertos por tests/tasks.test.ts — nada aqui toca o disco ou roda git.

export type TaskStatus = 'backlog' | 'fazendo' | 'revisao' | 'feito' | 'arquivada';
export const TASK_STATUSES: TaskStatus[] = ['backlog', 'fazendo', 'revisao', 'feito', 'arquivada'];

export type IntegrationStatus =
  | 'pendente'
  | 'integrando'
  | 'integrada'
  | 'conflito'
  | 'testes_falharam';

/** Slug curto em kebab-case (só [a-z0-9-]); sem acentos. `fallback` quando não sobra nada. */
export function slugify(input: string, fallback = ''): string {
  const base = (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos combinantes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || fallback;
}

/**
 * Nome de branch da tarefa: `tarefa/<slug-do-título>-<id>`.
 * Sempre uma referência git válida (só [a-z0-9-/]), mesmo com título acentuado ou vazio.
 */
export function taskBranch(title: string, id: number): string {
  const n = Number.isInteger(id) && id > 0 ? id : 0;
  const slug = slugify(title);
  return slug ? `tarefa/${slug}-${n}` : `tarefa/${n}`;
}

/** Diretório-raiz dos worktrees: $WORKTREES_DIR ou /srv/worktrees. */
export function worktreesRoot(): string {
  const env = process.env.WORKTREES_DIR;
  return env && env.trim() ? env.trim() : '/srv/worktrees';
}

/** `abs` é a própria raiz ou um descendente dela (comparação por segmentos, não por prefixo). */
export function isInside(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  const rel = path.relative(r, a);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Caminho do worktree: `<baseDir>/<slug-do-projeto>/<taskId>`.
 * O slug é sempre saneado ([a-z0-9-]), então nunca escapa da base; devolve null se algo for
 * inválido (base vazia, id não-inteiro) ou, por segurança, se o resultado sair da base.
 */
export function worktreePath(baseDir: string, projectSlug: string, taskId: number): string | null {
  if (typeof baseDir !== 'string' || !baseDir.trim()) return null;
  if (!Number.isInteger(taskId) || taskId <= 0) return null;
  const slug = slugify(String(projectSlug ?? ''), 'projeto');
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, slug, String(taskId));
  return isInside(base, abs) ? abs : null;
}

/**
 * Valida um nome de branch/ref para passar ao git com segurança.
 * Só letras, dígitos, `.`, `_`, `-`, `/`; sem `..`, sem `//`, sem começar/terminar com `/` ou `-`,
 * sem `.lock` no fim e sem terminar em `.`. Nunca deixamos texto do usuário chegar cru ao git.
 */
export function isSafeBranch(b: string): boolean {
  if (typeof b !== 'string' || !b || b.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false;
  if (b.includes('..') || b.includes('//')) return false;
  if (b.startsWith('/') || b.endsWith('/') || b.startsWith('-')) return false;
  if (b.endsWith('.lock') || b.endsWith('.')) return false;
  return true;
}

export type WorktreeEntry = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

/**
 * Parser de `git worktree list --porcelain`: blocos separados por linha em branco, cada linha é
 * `chave valor` (worktree/HEAD/branch) ou uma palavra só (`bare`, `detached`). `branch` vem sem o
 * prefixo `refs/heads/`.
 */
export function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  if (!out) return entries;
  let cur: WorktreeEntry | null = null;
  const flush = () => {
    if (cur) entries.push(cur);
    cur = null;
  };
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      cur = { path: val, head: null, branch: null, bare: false, detached: false };
    } else if (!cur) {
      continue;
    } else if (key === 'HEAD') {
      cur.head = val;
    } else if (key === 'branch') {
      cur.branch = val.replace(/^refs\/heads\//, '');
    } else if (key === 'bare') {
      cur.bare = true;
    } else if (key === 'detached') {
      cur.detached = true;
    }
  }
  flush();
  return entries;
}

/**
 * Veredito da integração a partir de {conflict, testsOk}:
 * conflito vence tudo; testes reprovados viram `testes_falharam`; caso contrário `integrada`.
 * `testsOk === null` significa que os testes foram pulados (sem script) e conta como ok.
 */
export function integrationVerdict(input: { conflict: boolean; testsOk: boolean | null }): IntegrationStatus {
  if (input.conflict) return 'conflito';
  if (input.testsOk === false) return 'testes_falharam';
  return 'integrada';
}

/** Só quando o veredito é `integrada` a tarefa vira `feito`. */
export function verdictIsDone(v: IntegrationStatus): boolean {
  return v === 'integrada';
}
