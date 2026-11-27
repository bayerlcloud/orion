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
let tempos: Record<string, number | undefined> = {};
let avisos: string[] = [];
let deployExit = 0, smokeExit = 0, rollbackExit = 0;
const opcoes = (cwd: string, prompt = 'pedido') => ({
  cwd, prompt, fila, pessoa: 'Danilo',
  projeto: { id: 1, path: repo, default_branch: 'main' },
  avisar: async (texto: string) => { avisos.push(texto); },
  rodar: async (cmd: string, args: string[], _cwd: string, timeoutMs?: number) => {
    rodados.push(`${cmd} ${args.join(' ')}`); tempos[args[0]] = timeoutMs;
    if (cmd === 'git' && args[0] === 'remote') return { code: 0, out: 'origin\n' };
    // Saída de 6 linhas: o texto do turno só pode trazer as 5 últimas.
    if (cmd === 'bash' && args[0] === './smoke.sh') return { code: smokeExit, out: smokeExit ? 'l1\nl2\nl3\nl4\nl5\nhome respondeu 502' : 'home 200' };
    if (cmd === 'bash' && args[0] === './rollback.sh') return { code: rollbackExit, out: rollbackExit ? 'symlink antigo sumiu' : 'voltou' };
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
  fila = new FilaIntegracao(); rodados = []; tempos = {}; avisos = []; deployExit = 0; smokeExit = 0; rollbackExit = 0;
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
    expect(r.texto).not.toContain('Smoke'); // sem smoke.sh na raiz, nada muda
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

describe('smoke pós-deploy com rollback (smoke.sh e rollback.sh na raiz, ao lado do deploy.sh)', () => {
  const comSmoke = async (rollback: boolean) => {
    await writeFile(path.join(repo, 'smoke.sh'), 'curl -sf https://x/ \n');
    if (rollback) await writeFile(path.join(repo, 'rollback.sh'), 'echo volta\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'smoke');
    await ganchosDaSessao(opcoes(wtD))!.antes();
    await edit(wtD, 1, '<p>y</p>');
    return ganchosDaSessao(opcoes(wtD))!.publicador.deploy();
  };
  it('smoke ok: roda depois do deploy.sh, com 2 min de teto, e o texto diz quanto levou', async () => {
    const r = await comSmoke(false);
    expect(r.ok).toBe(true);
    expect(rodados).toEqual(['git remote', 'git push origin main', 'bash ./deploy.sh', 'bash ./smoke.sh']);
    expect(tempos['./smoke.sh']).toBe(120_000);
    expect(r.texto).toMatch(/Smoke: ok \(\d+s\)/);
    expect(avisos).toEqual([]);
  });
  it('smoke falha com rollback.sh: roda o rollback (10 min), texto com as 5 últimas linhas, aviso no WhatsApp', async () => {
    smokeExit = 1;
    const r = await comSmoke(true);
    expect(r.ok).toBe(false);
    expect(rodados.slice(-2)).toEqual(['bash ./smoke.sh', 'bash ./rollback.sh']);
    expect(tempos['./rollback.sh']).toBe(600_000);
    expect(r.texto).toContain('Deploy feito.');
    expect(r.texto).toContain('Smoke FALHOU (exit 1');
    expect(r.texto).toContain('home respondeu 502');
    expect(r.texto).toContain('l2'); expect(r.texto).not.toContain('l1');
    expect(r.texto).toContain('rollback: ok');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain(path.basename(repo)); expect(avisos[0]).toContain('rollback: ok');
  });
  it('rollback.sh que falha é dito no texto', async () => {
    smokeExit = 1; rollbackExit = 2;
    const r = await comSmoke(true);
    expect(r.texto).toContain('rollback: falhou (exit 2)');
    expect(r.texto).toContain('symlink antigo sumiu');
  });
  it('rollback.sh que não pegou o cadeado (exit 75) é dito como "não rodou", não como falha', async () => {
    smokeExit = 1; rollbackExit = 75;
    const r = await comSmoke(true);
    expect(r.texto).toContain('rollback: não rodou (outro deploy segurou o cadeado por 5 min)');
    expect(r.texto).not.toContain('falhou');
    expect(avisos[0]).toContain('não rodou');
  });
  it('smoke falha sem rollback.sh: só registra e avisa', async () => {
    smokeExit = 1;
    const r = await comSmoke(false);
    expect(r.ok).toBe(false);
    expect(rodados).not.toContain('bash ./rollback.sh');
    expect(r.texto).toContain('rollback: sem rollback.sh');
    expect(avisos[0]).toContain('sem rollback.sh');
  });
  it('timeout do smoke conta como falha (rodar devolve exit 1 com o motivo na saída, como rodarPadrao faz ao matar)', async () => {
    smokeExit = 1;
    const o = opcoes(wtD);
    const rodarBase = o.rodar;
    o.rodar = async (cmd, args, cwd, t) => (args[0] === './smoke.sh' ? { code: 1, out: `[tempo esgotado: ${(t ?? 0) / 1000}s]` } : rodarBase(cmd, args, cwd, t));
    await writeFile(path.join(repo, 'smoke.sh'), 'sleep 999\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'smoke');
    await ganchosDaSessao(o)!.antes(); await edit(wtD, 1, '<p>y</p>');
    const r = await ganchosDaSessao(o)!.publicador.deploy();
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('Smoke FALHOU');
    expect(r.texto).toContain('tempo esgotado: 120s');
  });
  it('aviso que estoura não derruba o resultado', async () => {
    smokeExit = 1;
    const o = { ...opcoes(wtD), avisar: async () => { throw new Error('gateway fora'); } };
    await writeFile(path.join(repo, 'smoke.sh'), 'false\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'smoke');
    await ganchosDaSessao(o)!.antes(); await edit(wtD, 1, '<p>y</p>');
    const r = await ganchosDaSessao(o)!.publicador.deploy();
    expect(r.texto).toContain('Smoke FALHOU');
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
  it('smoke.sh entra no scope sem o cadeado global; rollback.sh espera o cadeado só 5 min e sai com 75', () => {
    const s = comandoIsolado('bash', ['./smoke.sh'], '/srv/projects/x', { uid: 1, agora: 1, isolar: true, env });
    expect(s.cmd).toBe('systemd-run'); expect(s.args).not.toContain('flock'); expect(s.args.slice(-2)).toEqual(['bash', './smoke.sh']);
    const r = comandoIsolado('bash', ['./rollback.sh'], '/srv/projects/x', { uid: 1, agora: 1, isolar: true, env });
    expect(r.cmd).toBe('systemd-run'); expect(r.args.slice(-8)).toEqual(['flock', '-w', '300', '-E', '75', DEPLOY_LOCK, 'bash', './rollback.sh']);
  });
  it('nome da unidade sai do nome da pasta, saneado', () => {
    expect(comandoIsolado('bash', ['./deploy.sh'], '/srv/projects/Sítio Novo!', { uid: 1, agora: 35, isolar: true, env }).unit).toBe('orion-deploy-s-tio-novo-z');
  });
});
