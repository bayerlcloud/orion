import { describe, it, expect } from 'vitest';
import { claudeMemoryDir, parseFrontmatter, toMarkdown, isSafeMdName, donoPorNome, indiceMemory } from '../server/memories/markdown';

describe('ponte de memória', () => {
  it('mapeia o caminho do projeto para a pasta do Claude', () => {
    expect(claudeMemoryDir('/home/danilo', '/srv/orion')).toBe('/home/danilo/.claude/projects/-srv-orion/memory');
  });
  it('lê frontmatter com name, description e type', () => {
    const md = '---\nname: orion-project\ndescription: "What Orion is"\nmetadata:\n  type: project\n---\n\n# Orion\n\ncorpo aqui';
    const p = parseFrontmatter(md);
    expect(p.name).toBe('orion-project'); expect(p.description).toBe('What Orion is'); expect(p.type).toBe('project');
    expect(p.body).toContain('corpo aqui');
  });
  it('sem frontmatter usa o texto todo como corpo', () => {
    const p = parseFrontmatter('só texto solto');
    expect(p.name).toBe(''); expect(p.body).toBe('só texto solto');
  });
  it('tipo desconhecido vira null', () => {
    expect(parseFrontmatter('---\nname: x\ntype: banana\n---\ncorpo').type).toBeNull();
  });
  it('gera markdown com frontmatter e título', () => {
    const md = toMarkdown({ code: 'abc', title: 'Título', summary: 'resumo', body_md: 'corpo', scope: 'project' });
    expect(md).toContain('name: abc'); expect(md).toContain('type: project'); expect(md).toContain('# Título'); expect(md).toContain('corpo');
    expect(parseFrontmatter(md).name).toBe('abc');
  });
  it('bloqueia nomes de arquivo perigosos', () => {
    expect(isSafeMdName('orion.md')).toBe(true);
    expect(isSafeMdName('../x.md')).toBe(false);
    expect(isSafeMdName('x.txt')).toBe(false);
  });
});

describe('ponte de memória: dono e índice', () => {
  const pessoas = [{ id: 1, name: 'Danilo' }, { id: 2, name: 'Laís' }, { id: 3, name: 'Guilherme' }];
  it('dono da memória type user é a única pessoa citada (sem acento conta)', () => {
    expect(donoPorNome("Danilo's role: dono do Orion", pessoas)).toBe(1);
    expect(donoPorNome('A Lais prefere respostas curtas', pessoas)).toBe(2);
  });
  it('sem pessoa citada, ou mais de uma, não inventa dono', () => {
    expect(donoPorNome('prefere respostas curtas', pessoas)).toBeNull();
    expect(donoPorNome('Danilo e Guilherme combinaram', pessoas)).toBeNull();
    expect(donoPorNome('danilovich', pessoas)).toBeNull();
  });
  it('o índice mantém o .md que só existe no disco e usa a linha do painel quando houver', () => {
    const arquivos = [
      { nome: 'do-painel.md', raw: '---\nname: do-painel\ndescription: velho\n---\nx' },
      { nome: 'so-no-disco.md', raw: '---\nname: so-no-disco\ndescription: criada pelo Claude\n---\ny' },
      { nome: 'MEMORY.md', raw: 'índice antigo' },
    ];
    const idx = indiceMemory('Orion', arquivos, new Map([['do-painel.md', '- [Do painel](do-painel.md): novo']]));
    expect(idx).toBe('# Memórias do projeto Orion\n\n- [Do painel](do-painel.md): novo\n- [so-no-disco](so-no-disco.md): criada pelo Claude\n');
  });
});
