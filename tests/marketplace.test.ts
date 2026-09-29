import { describe, it, expect } from 'vitest';
import { ehOficial, fonteTexto, fonteUrl, fonteValida, nomeValido, parseKnownMarketplaces } from '../server/tools/marketplace';
import { chavePlugin, indexarPrefs, planoDeComposicao } from '../server/tools/skillPrefs';
import type { SkillItem } from '../server/tools/skillsScan';

describe('validações (whitelist, nunca shell)', () => {
  it('nome de plugin/marketplace', () => {
    expect(nomeValido('caveman')).toBe(true);
    expect(nomeValido('ui-ux-pro-max-skill')).toBe(true);
    expect(nomeValido('a.b_c-1')).toBe(true);
    expect(nomeValido('')).toBe(false);
    expect(nomeValido('.oculto')).toBe(false);
    expect(nomeValido('-x')).toBe(false);
    expect(nomeValido('a b')).toBe(false);
    expect(nomeValido('a/b')).toBe(false);
    expect(nomeValido('a;rm')).toBe(false);
  });
  it('fonte de marketplace: dono/repo ou URL git https, nunca caminho local nem injeção', () => {
    expect(fonteValida('obra/superpowers')).toBe(true);
    expect(fonteValida('JuliusBrussee/caveman')).toBe(true);
    expect(fonteValida('https://github.com/thedotmack/claude-mem.git')).toBe(true);
    expect(fonteValida('https://gitlab.com/grupo/repo')).toBe(true);
    expect(fonteValida('/etc/passwd')).toBe(false);
    expect(fonteValida('../fora')).toBe(false);
    expect(fonteValida('file:///srv')).toBe(false);
    expect(fonteValida('git@github.com:x/y.git')).toBe(false);
    expect(fonteValida('https://x.com/a;rm -rf /')).toBe(false);
    expect(fonteValida('obra/superpowers && curl evil')).toBe(false);
  });
});

describe('marketplaces conhecidos', () => {
  const km = {
    caveman: { source: { source: 'github', repo: 'JuliusBrussee/caveman' }, installLocation: '/x/caveman', lastUpdated: '2026-09-29T10:47:47.450Z' },
    'superpowers-dev': { source: { source: 'git', url: 'https://github.com/obra/superpowers.git' }, installLocation: '/x/sp' },
  };
  it('parse tolerante e ordenado', () => {
    const r = parseKnownMarketplaces(km);
    expect(r.map(m => m.nome)).toEqual(['caveman', 'superpowers-dev']);
    expect(r[0].lastUpdated).toBe('2026-09-29T10:47:47.450Z');
    expect(r[1].lastUpdated).toBeNull();
    expect(parseKnownMarketplaces(null)).toEqual([]);
    expect(parseKnownMarketplaces('lixo')).toEqual([]);
    expect(parseKnownMarketplaces([1, 2])).toEqual([]);
  });
  it('fonte: texto, url e badge oficial', () => {
    expect(fonteTexto({ repo: 'a/b' })).toBe('a/b');
    expect(fonteUrl({ repo: 'a/b' })).toBe('https://github.com/a/b');
    expect(fonteUrl({ url: 'https://gitlab.com/x/y.git' })).toBe('https://gitlab.com/x/y.git');
    expect(fonteUrl(null)).toBeNull();
    expect(ehOficial({ repo: 'anthropics/claude-code' })).toBe(true);
    expect(ehOficial({ url: 'https://github.com/anthropics/skills.git' })).toBe(true);
    expect(ehOficial({ repo: 'obra/superpowers' })).toBe(false);
    expect(ehOficial(null)).toBe(false);
  });
});

describe('preferência de plugin inteiro na composição (chave plugin:<nome>)', () => {
  const CAT = '/srv/claude/catalog';
  const item = (o: Partial<SkillItem>): SkillItem => ({
    id: 'x', kind: 'skill', invocacao: 'a', name: 'a', description: '', origem: 'c3', fonte: 'usuário', plugin: null, ativacao: 'auto',
    habilitada: true, path: `${CAT}/skills/a/SKILL.md`, bytes: 0, refs_code_server: false, credencial: false, argument_hint: null,
    allowed_tools: null, model: null, duplicada_de: null, descricao_pt: null, ...o,
  });
  const itens = [
    item({ id: '1', plugin: 'caveman', invocacao: 'caveman:caveman', name: 'caveman', fonte: 'plugin: caveman', path: `${CAT}/plugins/caveman/skills/caveman/SKILL.md` }),
    item({ id: '2', plugin: 'superpowers', invocacao: 'superpowers:tdd', name: 'tdd', fonte: 'plugin: superpowers', path: `${CAT}/plugins/superpowers/skills/tdd/SKILL.md` }),
  ];
  it('chave', () => {
    expect(chavePlugin('caveman')).toBe('plugin:caveman');
  });
  it('sem preferência: os dois plugins carregam', () => {
    const p = planoDeComposicao(itens, indexarPrefs([]), 7, CAT);
    expect(p.pluginPaths).toEqual([`${CAT}/plugins/caveman`, `${CAT}/plugins/superpowers`]);
  });
  it('plugin desligado pra pessoa some da composição DELA, sem mexer nas skills individuais', () => {
    const prefs = indexarPrefs([{ chave: 'plugin:caveman', user_id: 7, ligada: false }]);
    expect(planoDeComposicao(itens, prefs, 7, CAT).pluginPaths).toEqual([`${CAT}/plugins/superpowers`]);
    expect(planoDeComposicao(itens, prefs, 8, CAT).pluginPaths).toEqual([`${CAT}/plugins/caveman`, `${CAT}/plugins/superpowers`]);
  });
  it('padrão "todos" desligado, pessoa religa por cima (precedência pessoa > todos)', () => {
    const prefs = indexarPrefs([
      { chave: 'plugin:caveman', user_id: 0, ligada: false },
      { chave: 'plugin:caveman', user_id: 7, ligada: true },
    ]);
    expect(planoDeComposicao(itens, prefs, 7, CAT).pluginPaths).toContain(`${CAT}/plugins/caveman`);
    expect(planoDeComposicao(itens, prefs, 8, CAT).pluginPaths).not.toContain(`${CAT}/plugins/caveman`);
  });
});
