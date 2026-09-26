import { describe, it, expect } from 'vitest';
import { claudeMemoryDir, parseFrontmatter, toMarkdown, isSafeMdName } from '../server/memories/markdown';

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
