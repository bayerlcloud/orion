import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ganchosDaSessao, _zerarTentativas } from '../server/integracao/turno';
import { FilaIntegracao } from '../server/integracao/fila';
import { commitTurno, integrate } from '../server/tasks/git';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
async function edit(dir: string, linha: number, texto: string) {
  const f = path.join(dir, 'index.html');
  const ls = (await readFile(f, 'utf8')).split('\n'); ls[linha] = texto;
  await writeFile(f, ls.join('\n'));
}

let repo = '', wtD = '', wtG = '';
let avisos: string[] = [];
let esperas = 0;
let fila: FilaIntegracao;
const opcoes = (cwd: string, prompt = 'pedido') => ({
  sessaoId: `s-${cwd}`, cwd, prompt, fila,
  projeto: { id: 1, path: repo, default_branch: 'main' },
  avisar: (t: string) => { avisos.push(t); },
  esperar: async () => { esperas++; },
});
const drenar = async () => { while (fila.tamanho(1)) await new Promise(r => setTimeout(r, 5)); };

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'integ-'));
  repo = path.join(base, 'repo'); wtD = path.join(base, 'wt-d'); wtG = path.join(base, 'wt-g');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  await writeFile(path.join(repo, 'index.html'), '<h1>a</h1>\n<p>x</p>\n<h2>b</h2>\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'inicio');
  g(repo, 'worktree', 'add', '-q', '-b', 'd', wtD); g(repo, 'worktree', 'add', '-q', '-b', 'g', wtG);
  avisos = []; esperas = 0; fila = new FilaIntegracao(); _zerarTentativas();
});

describe('ganchosDaSessao', () => {
  it('sessão na raiz ou sem projeto não recebe ganchos', () => {
    expect(ganchosDaSessao(opcoes(repo))).toBeUndefined();
    expect(ganchosDaSessao({ ...opcoes(wtD), projeto: null })).toBeUndefined();
  });
  it('fim do turno envia para a raiz', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    await ganchosDaSessao(opcoes(wtD, 'aumenta o h1'))!.depois!(true);
    await drenar();
    expect(await readFile(path.join(repo, 'index.html'), 'utf8')).toContain('class="big"');
    expect(avisos).toEqual([]);
  });
  it('turno interrompido também envia o que já foi editado', async () => {
    await edit(wtD, 1, '<p>y</p>');
    await ganchosDaSessao(opcoes(wtD))!.depois!(false);
    await drenar();
    expect(await readFile(path.join(repo, 'index.html'), 'utf8')).toContain('<p>y</p>');
  });
  it('commit que ficou para trás (reinício) sobe no turno seguinte, mesmo sem mudança nova', async () => {
    await edit(wtD, 1, '<p>y</p>'); await commitTurno(wtD, 'antes do reinício');
    await ganchosDaSessao(opcoes(wtD))!.depois!(true);
    await drenar();
    expect(await readFile(path.join(repo, 'index.html'), 'utf8')).toContain('<p>y</p>');
  });
  it('início do turno traz a base', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>'); await commitTurno(wtD, 'd'); await integrate(repo, 'd', 'main');
    await ganchosDaSessao(opcoes(wtG))!.antes!();
    expect(await readFile(path.join(wtG, 'index.html'), 'utf8')).toContain('class="big"');
  });
  it('conflito avisa a sessão; na 3ª desiste; depois não avisa mais', async () => {
    await edit(wtD, 0, '<h1>D</h1>'); await commitTurno(wtD, 'd'); await integrate(repo, 'd', 'main');
    for (let i = 0; i < 4; i++) {
      await edit(wtG, 0, `<h1>G${i}</h1>`);
      await ganchosDaSessao(opcoes(wtG))!.depois!(true);
      await drenar();
    }
    expect(avisos).toHaveLength(3);
    expect(avisos[0]).toContain('Conflito ao juntar sua mudança na raiz (index.html)');
    expect(avisos[1]).toContain('Conflito ao juntar');
    expect(avisos[2]).toContain('depois de 3 tentativas (index.html)');
    expect(await readFile(path.join(repo, 'index.html'), 'utf8')).toContain('<h1>D</h1>');
    for (const a of avisos) expect(a).not.toMatch(/[\u2013\u2014]/);
  });
  it('raiz suja espera 10 vezes e avisa', async () => {
    await edit(repo, 2, '<h2>editado direto</h2>');
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    await ganchosDaSessao(opcoes(wtD))!.depois!(true);
    await drenar();
    expect(esperas).toBe(10);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('A pasta raiz do projeto tem edição direta');
  });
  it('sucesso é registrado; falha que não é conflito avisa uma vez só', async () => {
    const notas: string[] = [];
    const base = { ...opcoes(wtD), registrar: (t: string) => { notas.push(t); } };
    await edit(wtD, 1, '<p>y</p>');
    await ganchosDaSessao(base)!.depois!(true);
    await drenar();
    expect(notas).toEqual(['Mudança enviada para a raiz (branch d).']);
    const falha = { ...base, integrar: async () => ({ ok: false, conflict: false, log: 'fatal: disco cheio' }) };
    for (let i = 0; i < 2; i++) {
      await edit(wtD, 1, `<p>z${i}</p>`);
      await ganchosDaSessao(falha)!.depois!(true);
      await drenar();
    }
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('fatal: disco cheio');
  });

  it('publicar: junta a worktree na raiz na hora; conflito e raiz suja viram motivo', async () => {
    await edit(wtD, 0, '<h1 class="big">a</h1>');
    const pub = ganchosDaSessao(opcoes(wtD, 'publica'))!.publicar!;
    expect(pub.raiz).toBe(repo);
    expect(await pub.juntar()).toBeNull();
    expect(await readFile(path.join(repo, 'index.html'), 'utf8')).toContain('class="big"');
    expect(await pub.juntar()).toBeNull(); // nada a frente: ok sem merge novo

    await edit(wtG, 0, '<h1 class="small">a</h1>');
    expect(await ganchosDaSessao(opcoes(wtG))!.publicar!.juntar()).toContain('conflito');

    await edit(repo, 2, '<h2>suja</h2>');
    await edit(wtD, 1, '<p>y</p>');
    expect(await ganchosDaSessao(opcoes(wtD))!.publicar!.juntar()).toContain('raiz');
  });
});

