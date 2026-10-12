import { describe, expect, it } from 'vitest';
import { rankearArquivos } from '../server/claude/mencaoArquivos';

describe('@arquivo no compositor', () => {
  it('nome começando pela busca vem primeiro, depois contendo, depois caminho', () => {
    const files = ['src/zz/old-composer.ts', 'web/src/claude/Composer.tsx', 'docs/composer/notas.md', 'README.md'];
    expect(rankearArquivos(files, 'comp')).toEqual(['web/src/claude/Composer.tsx', 'src/zz/old-composer.ts', 'docs/composer/notas.md']);
    expect(rankearArquivos(files, 'nada')).toEqual([]);
    expect(rankearArquivos(files, '', 2)).toHaveLength(2);
  });
});
