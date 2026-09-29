import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseSkillFrontmatter,
  scanSkillsDir,
  discoverSkills,
  applySkillOverrides,
  resolveSkillsOption,
} from '../server/claude/skills.js';

/**
 * Formato real de `SKILL.md` (frontmatter YAML simples, confirmado lendo um exemplo real neste
 * servidor: `~/.claude/skills/migrar/SKILL.md`, `danilo`@c3): `name`, `description`,
 * `argument-hint`, entre duas linhas `---`.
 */
describe('parseSkillFrontmatter', () => {
  it('lê name/description/argument-hint', () => {
    const raw = `---\nname: migrar\ndescription: Traz projetos do code-server.\nargument-hint: <nome>\n---\n\n# corpo\n`;
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'migrar', description: 'Traz projetos do code-server.', argumentHint: '<nome>' });
  });
  it('sem frontmatter: null', () => {
    expect(parseSkillFrontmatter('# só corpo, sem frontmatter\n')).toBeNull();
  });
  it('tira aspas simples/duplas do valor', () => {
    const raw = `---\nname: "com-aspas"\ndescription: 'outra aspa'\n---\n`;
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'com-aspas', description: 'outra aspa' });
  });
  it('chave desconhecida é ignorada, nunca lança', () => {
    const raw = `---\nname: x\nallowed-tools: Bash, Read\n---\n`;
    expect(() => parseSkillFrontmatter(raw)).not.toThrow();
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'x' });
  });
  it('frontmatter vazio: objeto vazio, não null', () => {
    expect(parseSkillFrontmatter('---\n---\n')).toEqual({});
  });
});

describe('scanSkillsDir / discoverSkills — varredura real do disco', () => {
  async function withTmp(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), 'orion-skills-test-'));
    try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('diretório ausente: lista vazia, nunca lança', async () => withTmp(async (dir) => {
    expect(await scanSkillsDir(path.join(dir, 'nao-existe'), 'project')).toEqual([]);
  }));

  it('uma skill normal (<base>/<nome>/SKILL.md)', async () => withTmp(async (dir) => {
    const skillDir = path.join(dir, 'minha-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: minha-skill\ndescription: Faz algo.\n---\n');
    const rows = await scanSkillsDir(dir, 'project');
    expect(rows).toEqual([{ name: 'minha-skill', description: 'Faz algo.', source: 'project', dir: skillDir }]);
  }));

  it('sem name no frontmatter: usa o nome da pasta', async () => withTmp(async (dir) => {
    const skillDir = path.join(dir, 'pasta-sem-name');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\ndescription: Sem name.\n---\n');
    const rows = await scanSkillsDir(dir, 'project');
    expect(rows[0].name).toBe('pasta-sem-name');
  }));

  it('pasta sem SKILL.md é ignorada (não é uma skill)', async () => withTmp(async (dir) => {
    await mkdir(path.join(dir, 'so-um-arquivo'), { recursive: true });
    await writeFile(path.join(dir, 'so-um-arquivo', 'nota.txt'), 'nada aqui');
    expect(await scanSkillsDir(dir, 'project')).toEqual([]);
  }));

  it('pasta "synced" sem SKILL.md própria: varre um nível a mais (bucket/skill), fonte "synced"', async () => withTmp(async (dir) => {
    const bucketDir = path.join(dir, 'synced', 'bucket-123');
    const skillDir = path.join(bucketDir, 'pdf');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: pdf\ndescription: Mexe com PDF.\n---\n');
    const rows = await scanSkillsDir(dir, 'user');
    expect(rows).toEqual([{ name: 'pdf', description: 'Mexe com PDF.', source: 'synced', dir: skillDir }]);
  }));

  it('discoverSkills junta projeto + usuário', async () => withTmp(async (dir) => {
    const projectPath = path.join(dir, 'proj');
    const homeDir = path.join(dir, 'home');
    const projSkill = path.join(projectPath, '.claude', 'skills', 'do-projeto');
    const userSkill = path.join(homeDir, '.claude', 'skills', 'do-usuario');
    await mkdir(projSkill, { recursive: true });
    await mkdir(userSkill, { recursive: true });
    await writeFile(path.join(projSkill, 'SKILL.md'), '---\nname: do-projeto\ndescription: A.\n---\n');
    await writeFile(path.join(userSkill, 'SKILL.md'), '---\nname: do-usuario\ndescription: B.\n---\n');
    const rows = await discoverSkills(projectPath, homeDir);
    expect(rows.map(r => [r.name, r.source]).sort()).toEqual([['do-projeto', 'project'], ['do-usuario', 'user']].sort());
  }));
});

describe('applySkillOverrides — funde descoberta + overrides salvos (pura)', () => {
  it('sem override: enabled true por padrão', () => {
    const rows = applySkillOverrides([{ name: 'a', description: '', source: 'project', dir: '/x' }], new Map());
    expect(rows).toEqual([{ name: 'a', description: '', source: 'project', dir: '/x', enabled: true }]);
  });
  it('com override false: enabled false', () => {
    const rows = applySkillOverrides([{ name: 'a', description: '', source: 'project', dir: '/x' }], new Map([['a', false]]));
    expect(rows[0].enabled).toBe(false);
  });
  it('override de skill que não existe mais é simplesmente ignorado (não inventa uma linha)', () => {
    const rows = applySkillOverrides([{ name: 'a', description: '', source: 'project', dir: '/x' }], new Map([['b', false]]));
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
  });
});

describe('resolveSkillsOption — o que passar em Options.skills do SDK (pura)', () => {
  it('nada desabilitado: undefined (comportamento de sempre, "não é skills off")', () => {
    expect(resolveSkillsOption(['a', 'b'], new Set())).toBeUndefined();
  });
  it('uma desabilitada: array com as demais', () => {
    expect(resolveSkillsOption(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
  });
  it('todas desabilitadas: array vazio (não undefined — undefined mudaria de "algumas off" pra "nenhuma opinião")', () => {
    expect(resolveSkillsOption(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });
});
