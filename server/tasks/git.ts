import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSafeBranch } from './util.js';

// Camada de git do kanban: sempre execFile (nunca shell), timeout curto, e todo caminho passa por
// realpath antes de virar cwd. Nomes de branch/base passam por isSafeBranch — nada do usuário
// chega cru à linha de comando.

const GIT_TIMEOUT = 20_000; // 20s por comando git
const TEST_TIMEOUT = 600_000; // 10min para a suíte de testes
const MAX_BUFFER = 32 * 1024 * 1024;
const DIFF_MAX_LINES = 4000;

type Ran = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<Ran> {
  return run('git', ['-c', 'core.quotePath=false', ...args], cwd, timeout);
}

const tail = (s: string, n = 8000): string => (s.length > n ? s.slice(s.length - n) : s);
const safeBase = (b: string): string => (isSafeBranch(b) ? b : 'main');

export type WorktreeResult = { ok: boolean; path: string | null; log: string };

/**
 * Cria um worktree novo em `targetPath` numa branch nova `branch` a partir de `baseBranch`.
 * (`git -C <repo> worktree add -b <branch> <targetPath> <base>`.) Cria a pasta-mãe se faltar.
 * Se `targetPath` não vier, cai num caminho derivado do nome do repo + branch, sob $WORKTREES_DIR.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  targetPath?: string,
): Promise<WorktreeResult> {
  if (!isSafeBranch(branch)) return { ok: false, path: null, log: `nome de branch inválido: ${branch}` };
  const repoReal = await realpath(repoPath).catch(() => null);
  if (!repoReal) return { ok: false, path: null, log: `repositório não encontrado: ${repoPath}` };
  const target =
    targetPath ?? path.join(process.env.WORKTREES_DIR || '/srv/worktrees', path.basename(repoReal), branch.replace(/\//g, '-'));
  await mkdir(path.dirname(target), { recursive: true }).catch(() => {});
  const r = await git(repoReal, ['worktree', 'add', '-b', branch, target, safeBase(baseBranch)]);
  if (r.code !== 0) return { ok: false, path: null, log: (r.stderr || r.stdout).trim() || 'falha ao criar worktree' };
  return { ok: true, path: target, log: (r.stdout || 'worktree criado').trim() };
}

/** Remove o worktree (best-effort) e faz prune se falhar. */
export async function removeWorktree(repoPath: string, worktreePath: string | null): Promise<WorktreeResult> {
  const repoReal = await realpath(repoPath).catch(() => null);
  if (!repoReal || !worktreePath) return { ok: false, path: null, log: 'sem repositório ou worktree' };
  const r = await git(repoReal, ['worktree', 'remove', '--force', worktreePath]);
  if (r.code !== 0) {
    await git(repoReal, ['worktree', 'prune']).catch(() => {});
    return { ok: false, path: worktreePath, log: (r.stderr || r.stdout).trim() || 'falha ao remover worktree' };
  }
  return { ok: true, path: worktreePath, log: (r.stdout || 'worktree removido').trim() };
}

export type IntegrateResult = { ok: boolean; conflict: boolean; log: string };

/**
 * Integra `branch` na `baseBranch`: faz checkout da base no repo e um merge --no-ff da branch.
 * Em conflito, aborta o merge e devolve `conflict:true`. Tudo local (sem rede).
 */
export async function integrate(repoPath: string, branch: string, baseBranch: string): Promise<IntegrateResult> {
  const repoReal = await realpath(repoPath).catch(() => null);
  if (!repoReal) return { ok: false, conflict: false, log: `repositório não encontrado: ${repoPath}` };
  if (!isSafeBranch(branch)) return { ok: false, conflict: false, log: `nome de branch inválido: ${branch}` };
  const base = safeBase(baseBranch);
  const logs: string[] = [];
  const step = async (args: string[]): Promise<Ran> => {
    const r = await git(repoReal, args);
    logs.push(`$ git ${args.join(' ')}\n${r.stdout}${r.stderr}`.trim());
    return r;
  };

  const co = await step(['checkout', base]);
  if (co.code !== 0) return { ok: false, conflict: false, log: logs.join('\n\n') };

  const merge = await step(['merge', '--no-ff', '--no-edit', branch]);
  if (merge.code !== 0) {
    const unmerged = await git(repoReal, ['ls-files', '--unmerged']);
    const conflict = unmerged.stdout.trim().length > 0 || /CONFLICT/i.test(merge.stdout + merge.stderr);
    if (conflict) await step(['merge', '--abort']);
    return { ok: false, conflict, log: logs.join('\n\n') };
  }
  return { ok: true, conflict: false, log: logs.join('\n\n') };
}

/**
 * Início do turno numa worktree (spec 2026-09-30-preview-design, Parte 2): traz o que as outras pessoas
 * já juntaram na base. Em conflito, aborta e a worktree fica como estava.
 */
export async function sincronizarComBase(worktree: string, baseBranch: string): Promise<{ ok: boolean; conflito: boolean; log: string }> {
  const m = await git(worktree, ['merge', '--no-edit', safeBase(baseBranch)]);
  const log = `${m.stdout}${m.stderr}`.trim();
  if (m.code === 0) return { ok: true, conflito: false, log };
  const unmerged = await git(worktree, ['ls-files', '--unmerged']);
  const conflito = unmerged.stdout.trim().length > 0 || /CONFLICT/i.test(log);
  if (conflito) await git(worktree, ['merge', '--abort']);
  return { ok: false, conflito, log };
}

/** Fim do turno: commita tudo o que mudou na worktree, com a primeira linha do pedido (até 72 letras). */
export async function commitTurno(worktree: string, mensagem: string): Promise<{ commitou: boolean; branch: string | null; log: string }> {
  const st = await git(worktree, ['status', '--porcelain']);
  const br = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.code === 0 ? br.stdout.trim() : null;
  if (st.code !== 0 || !st.stdout.trim()) return { commitou: false, branch, log: `${st.stdout}${st.stderr}`.trim() };
  const linha = (mensagem.split('\n').find(l => l.trim()) ?? 'turno').trim().slice(0, 72) || 'turno';
  // node_modules nunca entra: na worktree ele é um symlink para o da raiz, e `node_modules/` no .gitignore não casa symlink.
  const add = await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules']);
  if (add.code !== 0) return { commitou: false, branch, log: add.stderr };
  const c = await git(worktree, ['commit', '-q', '-m', linha]);
  return { commitou: c.code === 0, branch, log: `${c.stdout}${c.stderr}`.trim() };
}

/** Quantos commits a branch atual da worktree tem que a base ainda não tem (0 se der erro). */
export async function commitsAFrente(worktree: string, baseBranch: string): Promise<number> {
  const r = await git(worktree, ['rev-list', '--count', `${safeBase(baseBranch)}..HEAD`]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/** Raiz sem edição direta em arquivos rastreados (arquivo novo não rastreado não atrapalha o merge). */
export async function raizLimpa(repo: string): Promise<boolean> {
  const st = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  return st.code === 0 && st.stdout.trim() === '';
}

export type TestResult = { skipped: boolean; ok: boolean; tail: string };

/** Roda `npm test` no worktree se houver script "test"; senão pula. Corta a saída no fim. */
export async function runTests(worktreePath: string): Promise<TestResult> {
  const wtReal = await realpath(worktreePath).catch(() => null);
  if (!wtReal) return { skipped: true, ok: true, tail: 'worktree não encontrado' };
  let hasTest = false;
  try {
    const pkg = JSON.parse(await readFile(path.join(wtReal, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    hasTest = !!pkg.scripts?.test;
  } catch {
    hasTest = false;
  }
  if (!hasTest) return { skipped: true, ok: true, tail: 'sem script de testes — pulado' };
  const r = await run('npm', ['test'], wtReal, TEST_TIMEOUT);
  return { skipped: false, ok: r.code === 0, tail: tail(`${r.stdout}\n${r.stderr}`).trim() };
}

export type DiffResult = { stat: string; diff: string; truncated: boolean };

/** `git -C <worktree> diff <base>...HEAD --stat` + o diff unificado, cortado em 4000 linhas. */
export async function worktreeDiff(worktreePath: string, baseBranch: string, maxLines = DIFF_MAX_LINES): Promise<DiffResult> {
  const wtReal = await realpath(worktreePath).catch(() => null);
  if (!wtReal) return { stat: '', diff: '', truncated: false };
  const base = safeBase(baseBranch);
  const range = `${base}...HEAD`;
  const stat = await git(wtReal, ['diff', range, '--stat']);
  const full = await git(wtReal, ['diff', range]);
  const lines = full.stdout.split('\n');
  const truncated = lines.length > maxLines;
  return { stat: stat.stdout, diff: truncated ? lines.slice(0, maxLines).join('\n') : full.stdout, truncated };
}
