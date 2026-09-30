import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitTurno, integrate, raizLimpa, sincronizarComBase } from '../server/tasks/git';

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
