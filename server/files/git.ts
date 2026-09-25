import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { folderBadges, parseLog, parsePorcelain, type Commit, type GitCode, type GitStatusMap } from './util.js';

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Roda o git em `cwd`; null quando não é repositório, o git não existe ou estourou o tempo. */
export function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' },
    }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

export type GitStatusResult = {
  repo: boolean;
  files: GitStatusMap;
  folders: Record<string, { code: GitCode }>;
  ignored: string[];
};

/**
 * `git status --porcelain=v1 -z -uall --ignored=matching` relativo à raiz do projeto.
 * O porcelain v1 devolve caminhos relativos ao topo do repositório; se a raiz do projeto é uma
 * subpasta do repo, o prefixo é removido e o que fica fora da raiz é descartado.
 */
export async function gitStatus(root: string): Promise<GitStatusResult> {
  const empty: GitStatusResult = { repo: false, files: {}, folders: {}, ignored: [] };
  const top = (await runGit(root, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return empty;
  let out = await runGit(root, ['status', '--porcelain=v1', '-z', '-uall', '--ignored=matching']);
  if (out === null) out = await runGit(root, ['status', '--porcelain=v1', '-z', '-uall']);
  if (out === null) return { ...empty, repo: true };

  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const topReal = await realpath(top).catch(() => top);
  const prefix = path.relative(topReal, rootReal).split(path.sep).filter(Boolean).join('/');

  const parsed = parsePorcelain(out);
  const strip = (p: string): string | null => {
    if (!prefix) return p;
    if (p === prefix) return '';
    return p.startsWith(prefix + '/') ? p.slice(prefix.length + 1) : null;
  };
  const files: GitStatusMap = {};
  for (const [p, st] of Object.entries(parsed.files)) {
    const rel = strip(p);
    if (rel) files[rel] = st;
  }
  const ignored: string[] = [];
  for (const p of parsed.ignored) {
    const rel = strip(p);
    if (rel && ignored.length < 500) ignored.push(rel);
  }
  return { repo: true, files, folders: folderBadges(files), ignored };
}

/** Últimos 30 commits que tocaram o arquivo (segue renomeações). */
export async function gitTimeline(root: string, rel: string): Promise<{ repo: boolean; commits: Commit[] }> {
  const out = await runGit(root, ['log', '--follow', '--format=%H%x1f%an%x1f%at%x1f%s', '-n', '30', '--', rel]);
  if (out === null) {
    const top = await runGit(root, ['rev-parse', '--show-toplevel']);
    return { repo: !!top, commits: [] };
  }
  return { repo: true, commits: parseLog(out) };
}
