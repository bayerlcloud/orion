import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  compareNames, extOf, folderBadges, isBinary, isInside, joinRel, mimeOf, parseLog, parsePorcelain,
  relativeInside, resolveInside, sortEntries, validateName, validateRelName,
} from '../server/files/util.js';

const ROOT = path.resolve('/srv/projetos/orion');

describe('resolveInside — caminho seguro dentro da raiz', () => {
  it('resolve caminhos normais e a própria raiz', () => {
    expect(resolveInside(ROOT, '')).toBe(ROOT);
    expect(resolveInside(ROOT, '.')).toBe(ROOT);
    expect(resolveInside(ROOT, 'server/index.ts')).toBe(path.join(ROOT, 'server', 'index.ts'));
    expect(resolveInside(ROOT, './web/../server/db.ts')).toBe(path.join(ROOT, 'server', 'db.ts'));
  });
  it('rejeita travessia com ..', () => {
    expect(resolveInside(ROOT, '..')).toBeNull();
    expect(resolveInside(ROOT, '../outro')).toBeNull();
    expect(resolveInside(ROOT, 'a/../../b')).toBeNull();
    expect(resolveInside(ROOT, 'a/b/../../../etc/passwd')).toBeNull();
  });
  it('rejeita caminho absoluto, byte nulo e raiz vazia', () => {
    expect(resolveInside(ROOT, '/etc/passwd')).toBeNull();
    expect(resolveInside(ROOT, ROOT + '/server')).toBeNull();
    expect(resolveInside(ROOT, 'a\0b')).toBeNull();
    expect(resolveInside('', 'a')).toBeNull();
  });
  it('não confunde prefixo de string com pasta (orion vs orion-2)', () => {
    expect(isInside(ROOT, ROOT + '-2/x')).toBe(false);
    expect(isInside(ROOT, ROOT + '/x')).toBe(true);
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(ROOT, path.dirname(ROOT))).toBe(false);
  });
  it('relativeInside devolve caminho com barra normal', () => {
    expect(relativeInside(ROOT, path.join(ROOT, 'a', 'b.txt'))).toBe('a/b.txt');
    expect(relativeInside(ROOT, ROOT)).toBe('');
    expect(joinRel('', 'x')).toBe('x');
    expect(joinRel('a/b/', 'x')).toBe('a/b/x');
  });
});

describe('validateName / validateRelName', () => {
  it('recusa vazio, ponto, barra e caractere de controle', () => {
    expect(validateName('')).toBeTruthy();
    expect(validateName('   ')).toBeTruthy();
    expect(validateName('.')).toBeTruthy();
    expect(validateName('..')).toBeTruthy();
    expect(validateName('a/b')).toBeTruthy();
    expect(validateName('a\\b')).toBeTruthy();
    expect(validateName('a\nb')).toBeTruthy();
    expect(validateName('x'.repeat(256))).toBeTruthy();
  });
  it('aceita nomes comuns; validateRelName aceita a/b/c mas não barra inicial', () => {
    expect(validateName('index.ts')).toBeNull();
    expect(validateName('.env')).toBeNull();
    expect(validateName('Relatório final.pdf')).toBeNull();
    expect(validateRelName('src/pages/Novo.tsx')).toBeNull();
    expect(validateRelName('/abs')).toBeTruthy();
    expect(validateRelName('a/../b')).toBeTruthy();
  });
});

describe('ordenação natural com pastas primeiro', () => {
  it('compareNames é natural e sem distinguir caixa', () => {
    expect(compareNames('a2', 'a10')).toBeLessThan(0);
    expect(compareNames('file10.txt', 'file9.txt')).toBeGreaterThan(0);
    expect(compareNames('Zeta', 'alpha')).toBeGreaterThan(0);
    expect(compareNames('README.md', 'readme.md')).not.toBe(0); // desempate estável
  });
  it('sortEntries põe pastas (e symlinks para pasta) antes dos arquivos', () => {
    const sorted = sortEntries([
      { name: 'zeta.ts', type: 'file' },
      { name: 'b-dir', type: 'dir' },
      { name: 'Alpha.ts', type: 'file' },
      { name: 'a10', type: 'dir' },
      { name: 'a2', type: 'dir' },
      { name: 'link-dir', type: 'symlink', target: 'dir' },
      { name: 'link-file', type: 'symlink', target: 'file' },
      { name: '.env', type: 'file' },
    ]);
    expect(sorted.map(e => e.name)).toEqual(['a2', 'a10', 'b-dir', 'link-dir', '.env', 'Alpha.ts', 'link-file', 'zeta.ts']);
  });
});

describe('parsePorcelain — git status --porcelain=v1 -z', () => {
  const z = (...recs: string[]) => recs.join('\0') + '\0';

  it('mapeia modificado, adicionado, excluído e untracked com staged', () => {
    const { files } = parsePorcelain(z(' M src/a.ts', 'M  src/b.ts', 'A  novo.ts', ' D velho.ts', 'D  idx.ts', '?? solto.txt'));
    expect(files['src/a.ts']).toEqual({ code: 'M', staged: false });
    expect(files['src/b.ts']).toEqual({ code: 'M', staged: true });
    expect(files['novo.ts']).toEqual({ code: 'A', staged: true });
    expect(files['velho.ts']).toEqual({ code: 'D', staged: false });
    expect(files['idx.ts']).toEqual({ code: 'D', staged: true });
    expect(files['solto.txt']).toEqual({ code: 'U', staged: false });
  });
  it('working tree vence o índice quando os dois têm estado (MM, AM)', () => {
    const { files } = parsePorcelain(z('MM a.ts', 'AM b.ts'));
    expect(files['a.ts']).toEqual({ code: 'M', staged: false });
    expect(files['b.ts']).toEqual({ code: 'M', staged: false });
  });
  it('renomeação em -z: registro "R  novo" seguido do caminho antigo', () => {
    const { files } = parsePorcelain(z('R  src/novo.ts', 'src/old.ts', ' M outro.ts'));
    expect(files['src/novo.ts']).toEqual({ code: 'R', staged: true });
    expect(files['src/old.ts']).toBeUndefined();
    expect(files['outro.ts']).toEqual({ code: 'M', staged: false });
  });
  it('renomeação no formato sem -z: "R  old -> new"', () => {
    const { files } = parsePorcelain('R  old.ts -> new.ts\nC  a.ts -> b.ts\n?? x\n');
    expect(files['new.ts']).toEqual({ code: 'R', staged: true });
    expect(files['b.ts']).toEqual({ code: 'C', staged: true });
    expect(files['x']).toEqual({ code: 'U', staged: false });
    expect(files['old.ts']).toBeUndefined();
  });
  it('conflitos viram "!" e ignorados saem em ignored (sem barra final)', () => {
    const { files, ignored } = parsePorcelain(z('UU merge.ts', 'AA both.ts', 'DU d.ts', '!! node_modules/', '!! dist/'));
    expect(files['merge.ts']).toEqual({ code: '!', staged: false });
    expect(files['both.ts']).toEqual({ code: '!', staged: false });
    expect(files['d.ts']).toEqual({ code: '!', staged: false });
    expect(ignored).toEqual(['node_modules', 'dist']);
    expect(files['node_modules']).toBeUndefined();
  });
  it('entrada vazia e type-changed', () => {
    expect(parsePorcelain('')).toEqual({ files: {}, ignored: [] });
    expect(parsePorcelain(z(' T bin'))).toEqual({ files: { bin: { code: 'M', staged: false } }, ignored: [] });
  });
});

describe('folderBadges — propagação para as pastas', () => {
  it('marca todos os ancestrais, inclusive a raiz', () => {
    const f = folderBadges({ 'src/pages/A.tsx': { code: 'M', staged: false } });
    expect(Object.keys(f).sort()).toEqual(['', 'src', 'src/pages']);
    expect(f['src'].code).toBe('M');
  });
  it('exclusão não propaga (como propagate=false no VS Code)', () => {
    expect(folderBadges({ 'src/x.ts': { code: 'D', staged: false } })).toEqual({});
  });
  it('prioridade: conflito > modificado > untracked/adicionado', () => {
    const f = folderBadges({
      'a/u.ts': { code: 'U', staged: false },
      'a/m.ts': { code: 'M', staged: false },
      'b/u.ts': { code: 'U', staged: false },
      'c/x.ts': { code: '!', staged: false },
      'c/m.ts': { code: 'M', staged: false },
    });
    expect(f['a'].code).toBe('M');
    expect(f['b'].code).toBe('U');
    expect(f['c'].code).toBe('!');
    expect(f[''].code).toBe('!');
  });
});

describe('isBinary / mime', () => {
  it('detecta por extensão', () => {
    expect(isBinary('foto.PNG')).toBe(true);
    expect(isBinary('a/b/c.woff2')).toBe(true);
    expect(isBinary('texto.md')).toBe(false);
    expect(isBinary('sem-extensao')).toBe(false);
  });
  it('detecta por byte nulo nos primeiros 8 KB', () => {
    expect(isBinary('x.txt', new Uint8Array([104, 105, 0, 1]))).toBe(true);
    expect(isBinary('x.txt', new TextEncoder().encode('só texto\ncom acentos'))).toBe(false);
    const tail = new Uint8Array(9000); tail.fill(65); tail[8500] = 0;
    expect(isBinary('x.txt', tail)).toBe(false);
  });
  it('mimeOf e extOf', () => {
    expect(extOf('a.tar.gz')).toBe('gz');
    expect(extOf('.env')).toBe('');
    expect(mimeOf('logo.svg')).toBe('image/svg+xml');
    expect(mimeOf('x.bin')).toBe('application/octet-stream');
  });
});

describe('parseLog', () => {
  it('separa hash, autor, data e assunto', () => {
    const out = 'abcdef1234567\x1fAna\x1f1700000000\x1fcorrige: bug \x1f raro\n' + 'lixo\n' + '0123abc\x1fBia\x1f1700000100\x1finicial\n';
    const c = parseLog(out);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ hash: 'abcdef1234567', author: 'Ana', date: 1700000000, subject: 'corrige: bug \x1f raro' });
    expect(c[1].subject).toBe('inicial');
  });
});
