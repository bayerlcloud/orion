import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ESTILOS_EMBUTIDOS, gravarEstilo, lerEstilos, montarMd, slugDeNome, validarDescricao, validarInstrucoes, validarNome,
} from '../server/tools/outputStyles';

describe('slug do nome (vira o nome do arquivo, como o assistente real diz)', () => {
  it('casos comuns', () => {
    expect(slugDeNome('Diagrams first')).toBe('diagrams-first');
    expect(slugDeNome('  Café com Ações!!  ')).toBe('cafe-com-acoes');
    expect(slugDeNome('a__b..c')).toBe('a__b..c');
    expect(slugDeNome('---')).toBe('');
    expect(slugDeNome('...')).toBe('');
    expect(slugDeNome('X'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe('validações do assistente (mesmas regras da extensão real, em pt-BR)', () => {
  it('nome', () => {
    expect(validarNome('', [])).toBe('Digite um nome');
    expect(validarNome('a/b', [])).toContain('não pode conter');
    expect(validarNome('a---b', [])).toContain('não pode conter');
    expect(validarNome('a?b', [])).toContain('não pode conter');
    expect(validarNome('!!!', [])).toBe('Digite um nome com letras ou números');
    expect(validarNome('Explanatory', ['Explanatory'])).toContain('já é o nome de um estilo');
    // Colisão pelo SLUG também (o arquivo é o identificador): "Diagrams First" bate com "diagrams-first".
    expect(validarNome('Diagrams First', ['diagrams-first'])).toContain('já é o nome de um estilo');
    expect(validarNome('Diagrams first', [])).toBeNull();
  });
  it('descrição e instruções', () => {
    expect(validarDescricao('tem --- no meio')).toContain('---');
    expect(validarDescricao('ok')).toBeNull();
    expect(validarInstrucoes('   ')).toBe('Digite as instruções');
    expect(validarInstrucoes('faça x')).toBeNull();
  });
});

describe('arquivo .md do estilo', () => {
  it('frontmatter com name/description/keep-coding-instructions (chaves reais do CLI) + criado-por', () => {
    const md = montarMd({ nome: 'Diagrams first', descricao: 'Sempre com diagrama', instrucoes: 'Comece com um diagrama.', manterInstrucoesCodigo: true }, 'bayerl@x.com');
    expect(md).toContain('name: Diagrams first');
    expect(md).toContain('description: Sempre com diagrama');
    expect(md).toContain('keep-coding-instructions: true');
    expect(md).toContain('criado-por: bayerl@x.com');
    expect(md.trim().endsWith('Comece com um diagrama.')).toBe(true);
  });
  it('sem descrição a linha some; manter=false grava false', () => {
    const md = montarMd({ nome: 'X', descricao: '', instrucoes: 'i', manterInstrucoesCodigo: false }, 'a@b');
    expect(md).not.toContain('description:');
    expect(md).toContain('keep-coding-instructions: false');
  });
});

describe('catálogo em disco', () => {
  it('lerEstilos: embutidos sempre; customs com label/descrição/criador do frontmatter', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'estilos-'));
    try {
      const soEmbutidos = await lerEstilos(path.join(dir, 'nao-existe'));
      expect(soEmbutidos.map(e => e.nome)).toEqual(ESTILOS_EMBUTIDOS.map(e => e.nome));
      await writeFile(path.join(dir, 'diagrams-first.md'), montarMd({ nome: 'Diagrams first', descricao: 'Sempre com diagrama', instrucoes: 'x', manterInstrucoesCodigo: true }, 'bayerl@x.com'));
      const r = await lerEstilos(dir);
      const custom = r.find(e => e.nome === 'diagrams-first');
      expect(custom).toMatchObject({ label: 'Diagrams first', descricao: 'Sempre com diagrama', builtin: false, criado_por: 'bayerl@x.com' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('gravarEstilo: escreve no catálogo e faz o symlink no dir do usuário; nunca pisa em arquivo real', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'estilos-'));
    const dir = path.join(base, 'catalogo');
    const userDir = path.join(base, 'user');
    try {
      await gravarEstilo('meu-estilo', '---\nname: Meu\n---\ncorpo\n', { dir, userDir });
      expect(await readFile(path.join(dir, 'meu-estilo.md'), 'utf8')).toContain('corpo');
      expect(await readlink(path.join(userDir, 'meu-estilo.md'))).toBe(path.join(dir, 'meu-estilo.md'));
      // Regravar refaz o symlink sem erro.
      await gravarEstilo('meu-estilo', '---\nname: Meu\n---\ncorpo 2\n', { dir, userDir });
      expect(await readFile(path.join(dir, 'meu-estilo.md'), 'utf8')).toContain('corpo 2');
      // Arquivo REAL (não symlink) no dir do usuário: fica intocado.
      await writeFile(path.join(userDir, 'pessoal.md'), 'pessoal');
      await gravarEstilo('pessoal', 'do catálogo', { dir, userDir });
      expect(await readFile(path.join(userDir, 'pessoal.md'), 'utf8')).toBe('pessoal');
      expect(await readFile(path.join(dir, 'pessoal.md'), 'utf8')).toBe('do catálogo');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
