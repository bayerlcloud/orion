import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitTurno, commitsAFrente, integrate, raizLimpa, sincronizarComBase } from '../server/tasks/git';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
async function edit(dir: string, linha: number, texto: string) {
  const f = path.join(dir, 'index.html');
  const ls = (await readFile(f, 'utf8')).split('\n'); ls[linha] = texto;
  await writeFile(f, ls.join('\n'));
}

let repo = '', wtD = '', wtG = '';
beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'turno-'));
  repo = path.join(base, 'repo'); wtD = path.join(base, 'wt-d'); wtG = path.join(base, 'wt-g');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  await writeFile(path.join(repo, 'index.html'), '<h1>a</h1>\n<p>x</p>\n<h2>b</h2>\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'inicio');
  g(repo, 'worktree', 'add', '-q', '-b', 'd', wtD); g(repo, 'worktree', 'add', '-q', '-b', 'g', wtG);
});

describe('git do turno', () => {
  it('turno sem mudança não commita', async () => {
    expect((await commitTurno(wtD, 'nada')).commitou).toBe(false);
  });
  it('h1 e h2 de pessoas diferentes juntam sem conflito', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>'); await edit(wtG, 2, '<h2 class="red">b</h2>');
    expect(await commitTurno(wtD, 'aumenta o h1')).toMatchObject({ commitou: true, branch: 'd' });
    expect((await integrate(repo, 'd', 'main')).ok).toBe(true);
    expect((await commitTurno(wtG, 'h2 vermelho')).commitou).toBe(true);
    expect((await integrate(repo, 'g', 'main')).ok).toBe(true);
    const raiz = await readFile(path.join(repo, 'index.html'), 'utf8');
    expect(raiz).toContain('class="big"'); expect(raiz).toContain('class="red"');
  });
  it('node_modules como symlink nunca entra no commit, ignorado (info/exclude) ou não', async () => {
    const { symlink, appendFile } = await import('node:fs/promises');
    await symlink(repo, path.join(wtD, 'node_modules'));
    await edit(wtD, 1, '<p>um</p>');
    expect(await commitTurno(wtD, 'sem exclude')).toMatchObject({ commitou: true, sujo: true });
    expect(g(wtD, 'ls-files', 'node_modules').trim()).toBe('');
    // 01/10/2026: `node_modules` em .git/info/exclude fazia o add abortar ("paths are ignored") e o commit sumia
    await appendFile(path.join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
    await edit(wtD, 1, '<p>dois</p>');
    expect(await commitTurno(wtD, 'com exclude')).toMatchObject({ commitou: true, sujo: true });
    expect(g(wtD, 'ls-files', 'node_modules').trim()).toBe('');
    expect(g(wtD, 'log', '--oneline').trim().split('\n')).toHaveLength(3);
  });
  it('git que falha no commit devolve sujo: true e o motivo', async () => {
    await edit(wtD, 1, '<p>y</p>');
    g(wtD, 'config', 'commit.gpgsign', 'true'); g(wtD, 'config', 'gpg.program', '/bin/false');
    const r = await commitTurno(wtD, 'vai falhar');
    expect(r).toMatchObject({ commitou: false, sujo: true, branch: 'd' });
    expect(r.log.length).toBeGreaterThan(0);
  });
  it('mensagem longa vira uma linha de até 72 letras', async () => {
    await edit(wtD, 1, '<p>y</p>');
    await commitTurno(wtD, 'linha um bem comprida '.repeat(10) + '\nsegunda linha');
    const msg = g(wtD, 'log', '-1', '--format=%B').trim();
    expect(msg.split('\n')).toHaveLength(1);
    expect(msg.length).toBeLessThanOrEqual(72);
  });
  it('sincronizarComBase traz a mudança do outro', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>'); await commitTurno(wtD, 'x'); await integrate(repo, 'd', 'main');
    expect((await sincronizarComBase(wtG, 'main')).ok).toBe(true);
    expect(await readFile(path.join(wtG, 'index.html'), 'utf8')).toContain('class="big"');
  });
  it('mesma linha dá conflito e aborta limpo', async () => {
    await edit(wtD, 0, '<h1>D</h1>'); await commitTurno(wtD, 'd'); await integrate(repo, 'd', 'main');
    await edit(wtG, 0, '<h1>G</h1>'); await commitTurno(wtG, 'g');
    expect(await sincronizarComBase(wtG, 'main')).toMatchObject({ ok: false, conflito: true });
    expect(await raizLimpa(wtG)).toBe(true);
  });
  it('raizLimpa detecta edição direta', async () => {
    expect(await raizLimpa(repo)).toBe(true);
    await edit(repo, 1, '<p>y</p>');
    expect(await raizLimpa(repo)).toBe(false);
  });
});

describe('commitsAFrente', () => {
  it('conta commits da branch que a base ainda não tem', async () => {
    expect(await commitsAFrente(wtD, 'main')).toBe(0);
    await edit(wtD, 1, '<p>y</p>'); await commitTurno(wtD, 'y');
    expect(await commitsAFrente(wtD, 'main')).toBe(1);
    await integrate(repo, 'd', 'main');
    expect(await commitsAFrente(wtD, 'main')).toBe(0);
  });
});

describe('commitTurno nunca leva node_modules', () => {
  it('symlink node_modules na worktree não entra no commit', async () => {
    const { symlink, mkdir } = await import('node:fs/promises');
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'gi');
    await sincronizarComBase(wtD, 'main');
    await mkdir(path.join(repo, 'node_modules'));
    await symlink(path.join(repo, 'node_modules'), path.join(wtD, 'node_modules'));
    await edit(wtD, 1, '<p>y</p>');
    expect((await commitTurno(wtD, 'x')).commitou).toBe(true);
    expect(g(wtD, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('node_modules');
  });
  it('só o symlink node_modules não conta como sujo (publicar não trava)', async () => {
    const { symlink } = await import('node:fs/promises');
    await symlink(repo, path.join(wtD, 'node_modules'));
    expect(await commitTurno(wtD, 'x')).toMatchObject({ commitou: false, sujo: false });
  });
});
