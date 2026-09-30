import { execFile } from 'node:child_process';
import { lstat, readFile, symlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { instancia, type PreviewRow } from './model.js';

/**
 * Deixa a pasta de um preview pronta para o vite (spec 2026-09-30-preview-design, Parte 1) e grava o
 * `.env` que as units `preview@` e `preview-vite@` leem. Roda como danilo, dono das worktrees.
 */

const ENV_DIR = '/srv/previews';
const NPM_TIMEOUT = 10 * 60_000;

function rodar(cmd: string, args: string[], cwd: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-500))) : resolve());
  });
}

const existe = (p: string) => lstat(p).then(() => true, () => false);

/**
 * Worktree nova não tem node_modules: usa o da raiz por symlink se o package.json é o mesmo, senão
 * roda `npm ci` na própria worktree (dependência mudou na tarefa).
 */
export async function prepararPasta(dir: string, raiz: string, npm = 'npm'): Promise<'symlink' | 'npm-ci' | 'ja-tem' | 'raiz'> {
  if (path.resolve(dir) === path.resolve(raiz)) return 'raiz';
  const nm = path.join(dir, 'node_modules');
  if (await existe(nm)) return 'ja-tem';
  const [pkgDir, pkgRaiz] = await Promise.all([
    readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null),
    readFile(path.join(raiz, 'package.json'), 'utf8').catch(() => null),
  ]);
  if (pkgDir === pkgRaiz) {
    await symlink(path.join(raiz, 'node_modules'), nm, 'dir');
    return 'symlink';
  }
  await rodar(npm, ['ci'], dir, NPM_TIMEOUT);
  return 'npm-ci';
}

/** Para o vite da instância; o próximo acesso religa com a pasta nova (socket activation). */
async function pararVite(inst: string): Promise<void> {
  await rodar('sudo', ['-n', '/usr/local/sbin/orion-preview-stop', inst], '/', 30_000);
}

/**
 * Grava `<base>/<instancia>.env`; se a pasta mudou, para o vite daquele preview. Falha ao gravar lança;
 * falha ao parar volta em `erroParar` (o .env já está certo, o vite antigo cai sozinho no ocioso).
 */
export async function escreverEnv(p: PreviewRow, base = ENV_DIR, parar: (inst: string) => Promise<void> = pararVite): Promise<{ mudou: boolean; erroParar?: string }> {
  const inst = instancia(p.host);
  const arq = path.join(base, `${inst}.env`);
  const conteudo = `PREVIEW_DIR=${p.worktree_path}\nPREVIEW_PORT=${p.port}\nVITE_PORT=${p.port + 10000}\n`;
  if ((await readFile(arq, 'utf8').catch(() => null)) === conteudo) return { mudou: false };
  await mkdir(base, { recursive: true });
  await writeFile(arq, conteudo, { mode: 0o644 });
  try {
    await parar(inst);
  } catch (e) {
    return { mudou: true, erroParar: e instanceof Error ? e.message : String(e) };
  }
  return { mudou: true };
}

/**
 * O vite do preview roda como o usuário `preview`, só com leitura nas pastas; o cache de dependências
 * (`node_modules/.vite`) e o topo da pasta (config compilado do vite) são os lugares onde ele escreve. Com node_modules por symlink, o cache é o
 * da raiz, dividido com o preview raiz do projeto.
 */
export async function liberarCache(dir: string, setfacl: (args: string[]) => Promise<void> = (a) => rodar('setfacl', a, '/', 30_000)): Promise<void> {
  if (!(await existe(path.join(dir, 'node_modules')))) return;
  const cache = path.join(dir, 'node_modules', '.vite');
  await mkdir(cache, { recursive: true });
  await setfacl(['-R', '-m', 'u:preview:rwX,d:u:preview:rwX', cache]);
  // ponytail: vite 5 grava o vite.config.ts compilado ao lado dele (<pasta>/vite.config.ts.timestamp-*.mjs);
  // escrita só no topo da pasta, sem -R. Vite 6.1+ com --configLoader runner dispensaria isso.
  await setfacl(['-m', 'u:preview:rwx', dir]);
}
