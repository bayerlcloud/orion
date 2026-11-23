import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ganchosDaSessao, comandoIsolado, DEPLOY_LOCK } from '../server/integracao/turno';
import { FilaIntegracao } from '../server/integracao/fila';
import { commitTurno, integrate } from '../server/tasks/git';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
async function edit(dir: string, linha: number, texto: string) {
  const f = path.join(dir, 'index.html');
  const ls = (await readFile(f, 'utf8')).split('\n'); ls[linha] = texto;
  await writeFile(f, ls.join('\n'));
}
const raizTem = async (t: string) => (await readFile(path.join(repo, 'index.html'), 'utf8')).includes(t);

let repo = '', wtD = '', wtG = '';
let fila: FilaIntegracao;
let rodados: string[] = [];
let deployExit = 0;
const opcoes = (cwd: string, prompt = 'pedido') => ({
  cwd, prompt, fila, pessoa: 'Danilo',
  projeto: { id: 1, path: repo, default_branch: 'main' },
  rodar: async (cmd: string, args: string[]) => {
    rodados.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git' && args[0] === 'remote') return { code: 0, out: 'origin\n' };
    if (cmd === 'bash') return { code: deployExit, out: deployExit ? 'build quebrou' : 'publicado' };
    return { code: 0, out: '' };
  },
});

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'integ-'));
  repo = path.join(base, 'repo'); wtD = path.join(base, 'wt-d'); wtG = path.join(base, 'wt-g');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  await writeFile(path.join(repo, 'index.html'), '<h1>a</h1>\n<p>x</p>\n<h2>b</h2>\n');
  await writeFile(path.join(repo, 'deploy.sh'), 'echo ok\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'inicio');
  g(repo, 'worktree', 'add', '-q', '-b', 'd', wtD); g(repo, 'worktree', 'add', '-q', '-b', 'g', wtG);
  fila = new FilaIntegracao(); rodados = []; deployExit = 0;
});

describe('ganchosDaSessao', () => {
  it('sessão na raiz ou sem projeto não recebe ganchos', () => {
    expect(ganchosDaSessao(opcoes(repo))).toBeUndefined();
    expect(ganchosDaSessao({ ...opcoes(wtD), projeto: null })).toBeUndefined();
  });
  it('fim do turno só commita na worktree: nada sobe sozinho', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    await ganchosDaSessao(opcoes(wtD, 'aumenta o h1'))!.depois();
    expect(g(wtD, 'status', '--porcelain')).toBe('');
    expect(await raizTem('class="big"')).toBe(false);
  });
  it('início do turno traz a raiz', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>'); await commitTurno(wtD, 'd'); await integrate(repo, 'd', 'main');
    await ganchosDaSessao(opcoes(wtG))!.antes();
    expect(await readFile(path.join(wtG, 'index.html'), 'utf8')).toContain('class="big"');
  });
  it('publicar sobe para a raiz; de novo sem mudança não faz nada', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    const pub = ganchosDaSessao(opcoes(wtD, 'publica'))!.publicador;
    expect(pub.raiz).toBe(repo);
    expect(await pub.publicar()).toMatchObject({ ok: true });
    expect(await raizTem('class="big"')).toBe(true);
    expect((await pub.publicar()).texto).toContain('nada novo');
  });
  it('commit que falha na worktree é erro explícito, nunca "nada novo para subir"', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    g(wtD, 'config', 'commit.gpgsign', 'true'); g(wtD, 'config', 'gpg.program', '/bin/false');
    const r = await ganchosDaSessao(opcoes(wtD))!.publicador.publicar();
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('commit na worktree falhou');
    expect(await raizTem('class="big"')).toBe(false);
  });
  it('publicar com conflito volta para a sessão e não mexe na raiz', async () => {
    await edit(wtD, 0, '<h1>D</h1>');
    expect((await ganchosDaSessao(opcoes(wtD))!.publicador.publicar()).ok).toBe(true);
    await edit(wtG, 0, '<h1>G</h1>');
    const r = await ganchosDaSessao(opcoes(wtG))!.publicador.publicar();
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('conflito com a raiz (index.html)');
    expect(await raizTem('<h1>D</h1>')).toBe(true);
    for (const t of [r.texto]) expect(t).not.toMatch(/[–—]/);
  });
  it('publicar com raiz suja não sobe', async () => {
    await edit(repo, 2, '<h2>editado direto</h2>');
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    const r = await ganchosDaSessao(opcoes(wtD))!.publicador.publicar();
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('raiz tem edição direta');
  });
  it('deploy: publica, push no GitHub e deploy.sh da raiz, nessa ordem', async () => {
    await edit(wtD, 1, '<p>y</p>');
    const r = await ganchosDaSessao(opcoes(wtD))!.publicador.deploy();
    expect(r.ok).toBe(true);
    expect(await raizTem('<p>y</p>')).toBe(true);
    expect(rodados).toEqual(['git remote', 'git push origin main', 'bash ./deploy.sh']);
  });
  it('deploy: falha no deploy.sh é reportada; conflito cancela antes de tudo', async () => {
    deployExit = 1;
    await edit(wtD, 1, '<p>y</p>');
    const r = await ganchosDaSessao(opcoes(wtD))!.publicador.deploy();
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('FALHOU');
    rodados = [];
    await edit(wtG, 1, '<p>z</p>');
    const c = await ganchosDaSessao(opcoes(wtG))!.publicador.deploy();
    expect(c.texto).toContain('Deploy cancelado');
    expect(rodados).toEqual([]);
  });
});

describe('comandoIsolado: deploy.sh fora do cgroup do painel (23/11/2026)', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/danilo' };
  it('bash ./deploy.sh vira systemd-run --user --scope com teto de memória, slice própria e cadeado global', () => {
    const c = comandoIsolado('bash', ['./deploy.sh'], '/srv/projects/brandspace', { uid: 1001, agora: 1000, isolar: true, env });
    expect(c.cmd).toBe('systemd-run');
    expect(c.unit).toBe('orion-deploy-brandspace-rs');
    expect(c.args.slice(0, 3)).toEqual(['--user', '--scope', '--quiet']);
    expect(c.args).toContain('--slice=orion-deploys.slice');
    expect(c.args).toContain('MemoryMax=6G');
    expect(c.args.slice(-6)).toEqual(['flock', '-w', '1200', DEPLOY_LOCK, 'bash', './deploy.sh']);
    expect(c.env.XDG_RUNTIME_DIR).toBe('/run/user/1001');
    expect(c.env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1001/bus');
    expect(c.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(c.env.PATH).toBe('/usr/bin');
  });
  it('git e outros comandos seguem direto; ORION_DEPLOY_ISOLADO=0 desliga pro deploy.sh também', () => {
    const g = comandoIsolado('git', ['push'], '/srv/projects/x', { isolar: true, env });
    expect(g.cmd).toBe('git'); expect(g.unit).toBeNull(); expect(g.args).toEqual(['push']);
    const d = comandoIsolado('bash', ['./deploy.sh'], '/srv/projects/x', { isolar: false, env });
    expect(d.cmd).toBe('bash'); expect(d.unit).toBeNull();
  });
  it('nome da unidade sai do nome da pasta, saneado', () => {
    expect(comandoIsolado('bash', ['./deploy.sh'], '/srv/projects/Sítio Novo!', { uid: 1, agora: 35, isolar: true, env }).unit).toBe('orion-deploy-s-tio-novo-z');
  });
});
