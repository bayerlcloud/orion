import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  integrationVerdict,
  isInside,
  isSafeBranch,
  parseWorktrees,
  slugify,
  taskBranch,
  verdictIsDone,
  worktreePath,
} from '../server/tasks/util.js';

describe('slugify — kebab sem acentos', () => {
  it('tira acentos e normaliza para [a-z0-9-]', () => {
    expect(slugify('Corrigir a Autenticação!')).toBe('corrigir-a-autenticacao');
    expect(slugify('  Ação   Rápida  ')).toBe('acao-rapida');
    expect(slugify('São Paulo / Café')).toBe('sao-paulo-cafe');
  });
  it('devolve o fallback quando não sobra nada', () => {
    expect(slugify('', 'projeto')).toBe('projeto');
    expect(slugify('!!! ??? ...', 'x')).toBe('x');
    expect(slugify('')).toBe('');
  });
});

describe('taskBranch — nome de branch a partir do título', () => {
  it('gera tarefa/<slug>-<id> com título acentuado', () => {
    expect(taskBranch('Corrigir Login do Usuário', 42)).toBe('tarefa/corrigir-login-do-usuario-42');
    expect(taskBranch('Ação Rápida', 7)).toBe('tarefa/acao-rapida-7');
  });
  it('cai em tarefa/<id> quando o título não vira slug', () => {
    expect(taskBranch('', 3)).toBe('tarefa/3');
    expect(taskBranch('###', 9)).toBe('tarefa/9');
  });
  it('sempre produz uma branch git válida', () => {
    expect(isSafeBranch(taskBranch('Título com / barra e ..pontos', 5))).toBe(true);
    expect(isSafeBranch(taskBranch('', 1))).toBe(true);
  });
});

describe('worktreePath — construção segura do caminho', () => {
  const BASE = '/srv/worktrees';
  it('monta <base>/<slug>/<id>', () => {
    expect(worktreePath(BASE, 'orion', 5)).toBe(path.resolve('/srv/worktrees/orion/5'));
  });
  it('sanea o slug do projeto e nunca escapa da base (traversal)', () => {
    const p = worktreePath(BASE, '../../etc/passwd', 8)!;
    expect(p).not.toBeNull();
    expect(isInside(BASE, p)).toBe(true);
    expect(p.includes('..')).toBe(false);
    expect(p).toBe(path.resolve('/srv/worktrees/etc-passwd/8'));
  });
  it('rejeita id inválido e base vazia', () => {
    expect(worktreePath(BASE, 'orion', 0)).toBeNull();
    expect(worktreePath(BASE, 'orion', 1.5)).toBeNull();
    expect(worktreePath('', 'orion', 3)).toBeNull();
  });
});

describe('isInside — comparação por segmentos', () => {
  it('aceita a própria raiz e descendentes; recusa fora e prefixo de string', () => {
    expect(isInside('/srv/wt', '/srv/wt')).toBe(true);
    expect(isInside('/srv/wt', '/srv/wt/a/b')).toBe(true);
    expect(isInside('/srv/wt', '/srv/wt-2/a')).toBe(false);
    expect(isInside('/srv/wt', '/srv')).toBe(false);
    expect(isInside('/srv/wt', '/srv/wt/../x')).toBe(false);
  });
});

describe('isSafeBranch — validação de ref', () => {
  it('aceita refs normais', () => {
    expect(isSafeBranch('main')).toBe(true);
    expect(isSafeBranch('tarefa/corrige-login-42')).toBe(true);
    expect(isSafeBranch('feature/v1.2.3_x')).toBe(true);
  });
  it('recusa travessia, espaços, metacaracteres e formas inválidas', () => {
    expect(isSafeBranch('')).toBe(false);
    expect(isSafeBranch('a..b')).toBe(false);
    expect(isSafeBranch('a//b')).toBe(false);
    expect(isSafeBranch('/leading')).toBe(false);
    expect(isSafeBranch('trailing/')).toBe(false);
    expect(isSafeBranch('-flag')).toBe(false);
    expect(isSafeBranch('a b')).toBe(false);
    expect(isSafeBranch('rm -rf; ls')).toBe(false);
    expect(isSafeBranch('x.lock')).toBe(false);
    expect(isSafeBranch('$(whoami)')).toBe(false);
  });
});

describe('parseWorktrees — parse do porcelain', () => {
  it('lê vários worktrees com branch, detached e bare', () => {
    const out = [
      'worktree /srv/orion',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /srv/worktrees/orion/5',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/tarefa/corrige-5',
      '',
      'worktree /srv/wt/solto',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /srv/bare.git',
      'bare',
      '',
    ].join('\n');
    const wts = parseWorktrees(out);
    expect(wts).toHaveLength(4);
    expect(wts[0]).toMatchObject({ path: '/srv/orion', branch: 'main', detached: false, bare: false });
    expect(wts[1]).toMatchObject({ path: '/srv/worktrees/orion/5', branch: 'tarefa/corrige-5' });
    expect(wts[2]).toMatchObject({ path: '/srv/wt/solto', branch: null, detached: true });
    expect(wts[3]).toMatchObject({ path: '/srv/bare.git', bare: true });
  });
  it('devolve vazio para entrada vazia e ignora \\r', () => {
    expect(parseWorktrees('')).toEqual([]);
    const wts = parseWorktrees('worktree /a\r\nbranch refs/heads/x\r\n');
    expect(wts[0]).toMatchObject({ path: '/a', branch: 'x' });
  });
});

describe('integrationVerdict — matriz de veredito', () => {
  it('conflito vence tudo', () => {
    expect(integrationVerdict({ conflict: true, testsOk: true })).toBe('conflito');
    expect(integrationVerdict({ conflict: true, testsOk: false })).toBe('conflito');
    expect(integrationVerdict({ conflict: true, testsOk: null })).toBe('conflito');
  });
  it('testes reprovados sem conflito', () => {
    expect(integrationVerdict({ conflict: false, testsOk: false })).toBe('testes_falharam');
  });
  it('integrada quando passa ou os testes são pulados', () => {
    expect(integrationVerdict({ conflict: false, testsOk: true })).toBe('integrada');
    expect(integrationVerdict({ conflict: false, testsOk: null })).toBe('integrada');
  });
  it('só "integrada" fecha a tarefa como feito', () => {
    expect(verdictIsDone('integrada')).toBe(true);
    expect(verdictIsDone('conflito')).toBe(false);
    expect(verdictIsDone('testes_falharam')).toBe(false);
  });
});
