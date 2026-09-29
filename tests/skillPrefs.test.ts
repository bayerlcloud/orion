import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ehDoCatalogo, estadoDe, indexarPrefs, materializar, planoDeComposicao, raizDoPlugin } from '../server/tools/skillPrefs';
import type { SkillItem } from '../server/tools/skillsScan';

const CAT = '/srv/claude/catalog';
const item = (o: Partial<SkillItem>): SkillItem => ({
  id: 'x', kind: 'skill', invocacao: 'a', name: 'a', description: '', origem: 'c3', fonte: 'usuário', plugin: null, ativacao: 'auto',
  habilitada: true, path: `${CAT}/skills/a/SKILL.md`, bytes: 0, refs_code_server: false, credencial: false, argument_hint: null,
  allowed_tools: null, model: null, duplicada_de: null, descricao_pt: null, ...o,
});

describe('precedência', () => {
  it('pessoa > todos > ligada', () => {
    const prefs = indexarPrefs([{ chave: 'skill:a', user_id: 0, ligada: false }, { chave: 'skill:a', user_id: 7, ligada: true }, { chave: 'skill:b', user_id: 0, ligada: false }]);
    expect(estadoDe('skill:a', 7, prefs)).toEqual({ todos: false, eu: true, efetiva: true });
    expect(estadoDe('skill:a', 8, prefs)).toEqual({ todos: false, eu: null, efetiva: false });
    expect(estadoDe('skill:b', 7, prefs).efetiva).toBe(false);
    expect(estadoDe('skill:c', 7, prefs)).toEqual({ todos: null, eu: null, efetiva: true });
  });
});

describe('o que entra na composição', () => {
  it('só itens do catálogo; sincronizados, code-server e hooks ficam de fora', () => {
    expect(ehDoCatalogo(item({}), CAT)).toBe(true);
    expect(ehDoCatalogo(item({ path: '/home/danilo/.claude/skills/synced/b/x/SKILL.md', fonte: 'claude.ai (sincronizado)' }), CAT)).toBe(false);
    expect(ehDoCatalogo(item({ origem: 'code-server', path: '/srv/migracao/code-server/claude/skills/a/SKILL.md' }), CAT)).toBe(false);
    expect(ehDoCatalogo(item({ kind: 'hook', path: `${CAT}/settings.json` }), CAT)).toBe(false);
  });
  it('raiz do plugin no catálogo', () => {
    expect(raizDoPlugin(`${CAT}/plugins/superpowers/skills/tdd/SKILL.md`, CAT)).toBe(`${CAT}/plugins/superpowers`);
    expect(raizDoPlugin(`${CAT}/skills/a/SKILL.md`, CAT)).toBeNull();
  });
});

describe('plano de composição', () => {
  const itens = [
    item({ id: '1', invocacao: 'migrar', name: 'migrar', path: `${CAT}/skills/migrar/SKILL.md` }),
    item({ id: '2', kind: 'command', invocacao: 'riper:plan', name: 'riper:plan', path: `${CAT}/commands/riper/plan.md` }),
    item({ id: '3', plugin: 'superpowers', invocacao: 'superpowers:tdd', name: 'tdd', fonte: 'plugin: superpowers', path: `${CAT}/plugins/superpowers/skills/tdd/SKILL.md` }),
    item({ id: '4', plugin: 'superpowers', invocacao: 'superpowers:debug', name: 'debug', fonte: 'plugin: superpowers', path: `${CAT}/plugins/superpowers/skills/debug/SKILL.md` }),
    item({ id: '5', plugin: 'caveman', invocacao: 'caveman:caveman', name: 'caveman', fonte: 'plugin: caveman', path: `${CAT}/plugins/caveman/skills/caveman/SKILL.md` }),
    item({ id: '6', path: '/home/danilo/.claude/skills/synced/b/pdf/SKILL.md', invocacao: 'pdf', name: 'pdf', fonte: 'claude.ai (sincronizado)' }),
  ];
  it('tudo ligado por padrão: links dos soltos, plugins inteiros, nada bloqueado', () => {
    const p = planoDeComposicao(itens, indexarPrefs([]), 7, CAT);
    expect(p.links.map(l => l.name)).toEqual(['migrar', 'riper:plan']);
    expect(p.links[0].from).toBe(`${CAT}/skills/migrar`);
    expect(p.links[1].from).toBe(`${CAT}/commands/riper/plan.md`);
    expect(p.pluginPaths).toEqual([`${CAT}/plugins/caveman`, `${CAT}/plugins/superpowers`]);
    expect(p.disallowed).toEqual([]);
  });
  it('skill desligada dentro de plugin ligado vira Skill(plugin:nome); plugin todo desligado nem carrega', () => {
    const prefs = indexarPrefs([
      { chave: 'skill:superpowers:debug', user_id: 7, ligada: false },
      { chave: 'skill:caveman:caveman', user_id: 0, ligada: false },
      { chave: 'command:riper:plan', user_id: 0, ligada: false },
    ]);
    const p = planoDeComposicao(itens, prefs, 7, CAT);
    expect(p.links.map(l => l.name)).toEqual(['migrar']);
    expect(p.pluginPaths).toEqual([`${CAT}/plugins/superpowers`]);
    expect(p.disallowed).toEqual(['Skill(superpowers:debug)']);
  });
});

describe('materializar', () => {
  it('cria o plugin de composição com links e devolve as opções do SDK', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-'));
    try {
      const r = await materializar({
        links: [{ kind: 'skill', name: 'migrar', from: '/x/skills/migrar' }, { kind: 'command', name: 'riper:plan', from: '/x/commands/riper/plan.md' }],
        pluginPaths: ['/x/plugins/superpowers'], disallowed: ['Skill(superpowers:debug)'],
      }, 7, dir);
      expect(r.plugins).toEqual([{ type: 'local', path: path.join(dir, '7') }, { type: 'local', path: '/x/plugins/superpowers' }]);
      expect(r.disallowedTools).toEqual(['Skill(superpowers:debug)']);
      expect(JSON.parse(await readFile(path.join(dir, '7', '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('bayerl');
      expect(await readlink(path.join(dir, '7', 'skills', 'migrar'))).toBe('/x/skills/migrar');
      expect(await readlink(path.join(dir, '7', 'commands', 'riper', 'plan.md'))).toBe('/x/commands/riper/plan.md');
      const r2 = await materializar({ links: [], pluginPaths: ['/x/plugins/caveman'], disallowed: [] }, 7, dir);
      expect(r2.plugins).toEqual([{ type: 'local', path: '/x/plugins/caveman' }]);
      await expect(stat(path.join(dir, '7'))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
