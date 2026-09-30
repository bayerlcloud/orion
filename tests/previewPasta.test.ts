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
    const npm = path.join(base, 'npm'); await writeFile(npm, '#!/bin/sh\nmkdir -p node_modules && touch node_modules/ok\n', { mode: 0o755 });
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
    expect(await readFile(path.join(dir, 'danilo.fisio.env'), 'utf8')).toBe('PREVIEW_DIR=/a\nPREVIEW_PORT=9101\nVITE_PORT=19101\n');
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
    expect(chamadas).toEqual([['-R', '-m', 'u:preview:rwX,d:u:preview:rwX', path.join(dir, 'node_modules', '.vite')]]);
  });
  it('pasta sem node_modules não ganha nada', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pv-cache-'));
    const chamadas: string[][] = [];
    await liberarCache(dir, async (args) => { chamadas.push(args); });
    expect(await readdir(dir)).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});
