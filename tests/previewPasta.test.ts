import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepararPasta, escreverEnv, liberarCache } from '../server/preview/pasta';

async function projeto(pkg: string) {
  const base = await mkdtemp(path.join(tmpdir(), 'pv-'));
  const raiz = path.join(base, 'raiz'); const wt = path.join(base, 'wt');
  await mkdir(path.join(raiz, 'node_modules'), { recursive: true }); await mkdir(wt);
  await writeFile(path.join(raiz, 'package.json'), '{"name":"a"}'); await writeFile(path.join(wt, 'package.json'), pkg);
  return { base, raiz, wt };
}

describe('prepararPasta', () => {
  it('pasta da raiz não mexe em nada', async () => expect(await prepararPasta('/r', '/r')).toBe('raiz'));
  it('package.json igual cria symlink', async () => {
    const { raiz, wt } = await projeto('{"name":"a"}');
    expect(await prepararPasta(wt, raiz)).toBe('symlink');
    expect((await lstat(path.join(wt, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await prepararPasta(wt, raiz)).toBe('ja-tem');
  });
  it('package.json diferente roda npm ci, sem symlink', async () => {
    const { base, raiz, wt } = await projeto('{"name":"b"}');
    const npm = path.join(base, 'npm'); await writeFile(npm, '#!/bin/sh\n[ "$*" = "ci --include=dev" ] || exit 9\nmkdir -p node_modules && touch node_modules/ok\n', { mode: 0o755 });
    expect(await prepararPasta(wt, raiz, npm)).toBe('npm-ci');
    expect((await lstat(path.join(wt, 'node_modules'))).isSymbolicLink()).toBe(false);
    expect(await readdir(path.join(wt, 'node_modules'))).toEqual(['ok']);
  });
});

describe('escreverEnv', () => {
  it('muda só quando a pasta muda', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-env-'));
    const parados: string[] = [];
    const p = { id: 1, project_id: 1, user_id: 1, host: 'danilo.fisio.bayerl.cloud', port: 9101, worktree_path: '/a' };
    expect((await escreverEnv(p, dir, async (i) => { parados.push(i); })).mudou).toBe(true);
    expect(await readFile(path.join(dir, 'danilo.fisio.env'), 'utf8')).toBe('PREVIEW_DIR=/a\nPREVIEW_PORT=9101\nVITE_PORT=19101\nVITE_BIN=/a/node_modules/.bin/vite\n');
    expect((await escreverEnv(p, dir, async (i) => { parados.push(i); })).mudou).toBe(false);
    await escreverEnv({ ...p, worktree_path: '/b' }, dir, async (i) => { parados.push(i); });
    expect(parados).toEqual(['danilo.fisio', 'danilo.fisio']);
  });
});

describe('liberarCache', () => {
  it('cria node_modules/.vite e dá rwX ao usuário preview, também como padrão', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-cache-'));
    await mkdir(path.join(dir, 'node_modules'));
    const chamadas: string[][] = [];
    await liberarCache(dir, async (args) => { chamadas.push(args); });
    expect((await lstat(path.join(dir, 'node_modules', '.vite'))).isDirectory()).toBe(true);
    expect(chamadas).toEqual([
      ['-R', '-m', 'u:preview:rwX,d:u:preview:rwX', path.join(dir, 'node_modules', '.vite')],
      ['-R', '-m', 'u:preview:rwX,d:u:preview:rwX', path.join(dir, 'node_modules', '.vite-temp')],
      ['-m', 'u:preview:rwx', dir],
    ]);
  });
  it('pasta sem node_modules não ganha nada', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-cache-'));
    const chamadas: string[][] = [];
    await liberarCache(dir, async (args) => { chamadas.push(args); });
    expect(await readdir(dir)).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});

describe('escreverEnv com falha ao parar', () => {
  it('grava o .env e devolve o erro de parar, sem lançar', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-env-'));
    const p = { id: 1, project_id: 1, user_id: 1, host: 'x.y.bayerl.cloud', port: 9105, worktree_path: '/w' };
    const r = await escreverEnv(p, dir, async () => { throw new Error('sudo: senha necessária'); });
    expect(r).toEqual({ mudou: true, erroParar: 'sudo: senha necessária' });
    expect(await readFile(path.join(dir, 'x.y.env'), 'utf8')).toContain('PREVIEW_DIR=/w');
  });
  it('falha ao gravar lança', async () => {
    const p = { id: 1, project_id: 1, user_id: 1, host: 'x.y.bayerl.cloud', port: 9105, worktree_path: '/w' };
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-env-'));
    await writeFile(path.join(dir, 'arquivo'), '');
    await expect(escreverEnv(p, path.join(dir, 'arquivo', 'sub'), async () => {})).rejects.toThrow();
  });
});

describe('app em subpasta (monorepo)', () => {
  it('env aponta PREVIEW_DIR para a subpasta e VITE_BIN para o vite da base', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-env-'));
    const p = { id: 1, project_id: 1, user_id: null, host: 'abc.bayerl.cloud', port: 9110, worktree_path: '/srv/projects/abc' };
    await escreverEnv(p, dir, async () => {}, 'apps/portal');
    expect(await readFile(path.join(dir, 'abc.env'), 'utf8')).toBe('PREVIEW_DIR=/srv/projects/abc/apps/portal\nPREVIEW_PORT=9110\nVITE_PORT=19110\nVITE_BIN=/srv/projects/abc/node_modules/.bin/vite\n');
  });
  it('subpasta com .. é recusada', async () => {
    const p = { id: 1, project_id: 1, user_id: null, host: 'abc.bayerl.cloud', port: 9110, worktree_path: '/srv/projects/abc' };
    await expect(escreverEnv(p, tmpdir(), async () => {}, '../outro')).rejects.toThrow();
  });
  it('liberarCache na subpasta: cache e escrita no app, desde que a base tenha node_modules', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pv-mono-'));
    await mkdir(path.join(base, 'node_modules')); await mkdir(path.join(base, 'apps', 'portal'), { recursive: true });
    const chamadas: string[][] = [];
    await liberarCache(path.join(base, 'apps', 'portal'), async (a) => { chamadas.push(a); }, base);
    expect(chamadas).toEqual([
      ['-R', '-m', 'u:preview:rwX,d:u:preview:rwX', path.join(base, 'apps', 'portal', 'node_modules', '.vite')],
      ['-R', '-m', 'u:preview:rwX,d:u:preview:rwX', path.join(base, 'apps', 'portal', 'node_modules', '.vite-temp')],
      ['-m', 'u:preview:rwx', path.join(base, 'apps', 'portal')],
    ]);
  });
});
