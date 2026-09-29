import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PERMISSION_BEHAVIORS,
  emptyRuleSet,
  validateRuleText,
  settingsPathForScope,
  parseSettingsPermissions,
  mergeSettingsPermissions,
  addRule,
  removeRule,
  replaceRule,
  readPermissionRuleSet,
  writePermissionRuleSet,
  mutatePermissionRuleSet,
  type PermissionRuleSet,
} from '../server/claude/permissionRules';

describe('PERMISSION_BEHAVIORS', () => {
  it('é allow/ask/deny nessa ordem (mesma ordem da extensão real, xA1)', () => {
    expect(PERMISSION_BEHAVIORS).toEqual(['allow', 'ask', 'deny']);
  });
});

describe('emptyRuleSet', () => {
  it('devolve os 3 arrays vazios', () => {
    expect(emptyRuleSet()).toEqual({ allow: [], ask: [], deny: [] });
  });
  it('cada chamada devolve uma instância nova (sem estado compartilhado)', () => {
    const a = emptyRuleSet(); const b = emptyRuleSet();
    a.allow.push('x');
    expect(b.allow).toEqual([]);
  });
});

describe('validateRuleText', () => {
  it('aceita uma regra normal', () => {
    expect(validateRuleText('Bash(npm run test:*)')).toBeNull();
  });
  it('aceita um nome de ferramenta sozinho, sem especificador', () => {
    expect(validateRuleText('WebFetch')).toBeNull();
  });
  it('rejeita vazio', () => {
    expect(validateRuleText('')).toBe('Informe uma regra de permissão.');
  });
  it('rejeita só espaços', () => {
    expect(validateRuleText('   ')).toBe('Informe uma regra de permissão.');
  });
  it('rejeita regra maior que 400 caracteres', () => {
    expect(validateRuleText('A'.repeat(401))).toContain('máx. 400');
  });
  it('aceita exatamente 400 caracteres', () => {
    expect(validateRuleText('A'.repeat(400))).toBeNull();
  });
});

describe('settingsPathForScope', () => {
  it('scope "user": <homeDir>/.claude/settings.json', () => {
    expect(settingsPathForScope('user', { homeDir: '/home/danilo' })).toBe('/home/danilo/.claude/settings.json');
  });
  it('scope "project": <projectPath>/.claude/settings.json', () => {
    expect(settingsPathForScope('project', { homeDir: '/home/danilo', projectPath: '/srv/projects/brandspace' })).toBe('/srv/projects/brandspace/.claude/settings.json');
  });
  it('scope "project" sem projectPath: lança erro (nunca escreve em lugar nenhum sem saber onde)', () => {
    expect(() => settingsPathForScope('project', { homeDir: '/home/danilo' })).toThrow();
  });
  it('scope "project" com projectPath relativo: lança erro (nunca aceita path relativo)', () => {
    expect(() => settingsPathForScope('project', { homeDir: '/home/danilo', projectPath: 'relative/path' })).toThrow();
  });
  it('scope "user" com homeDir relativo: lança erro', () => {
    expect(() => settingsPathForScope('user', { homeDir: 'relative' })).toThrow();
  });
});

describe('parseSettingsPermissions', () => {
  it('settings.json sem chave permissions: 3 arrays vazios', () => {
    expect(parseSettingsPermissions({ model: 'sonnet' })).toEqual({ allow: [], ask: [], deny: [] });
  });
  it('extrai allow/ask/deny quando presentes', () => {
    const raw = { permissions: { allow: ['Bash(ls *)'], deny: ['Bash(rm -rf *)'], ask: ['WebFetch'] } };
    expect(parseSettingsPermissions(raw)).toEqual({ allow: ['Bash(ls *)'], ask: ['WebFetch'], deny: ['Bash(rm -rf *)'] });
  });
  it('raw undefined: 3 arrays vazios, não lança', () => {
    expect(parseSettingsPermissions(undefined)).toEqual({ allow: [], ask: [], deny: [] });
  });
  it('raw não-objeto (array, string, número): 3 arrays vazios, não lança', () => {
    expect(parseSettingsPermissions([1, 2, 3])).toEqual({ allow: [], ask: [], deny: [] });
    expect(parseSettingsPermissions('lixo')).toEqual({ allow: [], ask: [], deny: [] });
    expect(parseSettingsPermissions(42)).toEqual({ allow: [], ask: [], deny: [] });
  });
  it('entradas não-string dentro do array são filtradas, defensivamente', () => {
    const raw = { permissions: { allow: ['Bash(ls *)', 42, null, { x: 1 }] } };
    expect(parseSettingsPermissions(raw).allow).toEqual(['Bash(ls *)']);
  });
  it('permissions.allow não é array (ex.: string solta): vira vazio, não lança', () => {
    expect(parseSettingsPermissions({ permissions: { allow: 'oops' } }).allow).toEqual([]);
  });
});

describe('mergeSettingsPermissions', () => {
  it('em cima de raw undefined, cria { permissions: {...} } do zero', () => {
    const set: PermissionRuleSet = { allow: ['Bash(ls *)'], ask: [], deny: [] };
    expect(mergeSettingsPermissions(undefined, set)).toEqual({ permissions: { allow: ['Bash(ls *)'], ask: [], deny: [] } });
  });
  it('preserva outras chaves de nível superior (model, env, hooks...)', () => {
    const raw = { model: 'sonnet', env: { X: '1' } };
    const set: PermissionRuleSet = { allow: [], ask: [], deny: ['Bash(rm -rf *)'] };
    const merged = mergeSettingsPermissions(raw, set) as any;
    expect(merged.model).toBe('sonnet');
    expect(merged.env).toEqual({ X: '1' });
    expect(merged.permissions).toEqual({ allow: [], ask: [], deny: ['Bash(rm -rf *)'] });
  });
  it('preserva outras subchaves de permissions (defaultMode, additionalDirectories...)', () => {
    const raw = { permissions: { defaultMode: 'acceptEdits', additionalDirectories: ['/tmp/x'], allow: ['old'] } };
    const set: PermissionRuleSet = { allow: ['new'], ask: [], deny: [] };
    const merged = mergeSettingsPermissions(raw, set) as any;
    expect(merged.permissions.defaultMode).toBe('acceptEdits');
    expect(merged.permissions.additionalDirectories).toEqual(['/tmp/x']);
    expect(merged.permissions.allow).toEqual(['new']);
  });
  it('não muda o objeto raw original (imutável)', () => {
    const raw = { permissions: { allow: ['old'] } };
    mergeSettingsPermissions(raw, { allow: ['new'], ask: [], deny: [] });
    expect(raw.permissions.allow).toEqual(['old']);
  });
});

describe('addRule', () => {
  it('adiciona numa lista vazia', () => {
    expect(addRule(emptyRuleSet(), 'allow', 'Bash(ls *)')).toEqual({ allow: ['Bash(ls *)'], ask: [], deny: [] });
  });
  it('não duplica regra idêntica já presente', () => {
    const set: PermissionRuleSet = { allow: ['Bash(ls *)'], ask: [], deny: [] };
    expect(addRule(set, 'allow', 'Bash(ls *)')).toEqual(set);
  });
  it('corta espaço em volta antes de comparar/guardar', () => {
    expect(addRule(emptyRuleSet(), 'deny', '  Bash(rm -rf *)  ')).toEqual({ allow: [], ask: [], deny: ['Bash(rm -rf *)'] });
  });
  it('não muda o set original (imutável)', () => {
    const set = emptyRuleSet();
    addRule(set, 'allow', 'X');
    expect(set.allow).toEqual([]);
  });
});

describe('removeRule', () => {
  it('remove a regra exata', () => {
    const set: PermissionRuleSet = { allow: ['A', 'B'], ask: [], deny: [] };
    expect(removeRule(set, 'allow', 'A')).toEqual({ allow: ['B'], ask: [], deny: [] });
  });
  it('regra ausente: sem mudança, sem lançar', () => {
    const set: PermissionRuleSet = { allow: ['A'], ask: [], deny: [] };
    expect(removeRule(set, 'allow', 'Z')).toEqual(set);
  });
  it('não muda o set original (imutável)', () => {
    const set: PermissionRuleSet = { allow: ['A'], ask: [], deny: [] };
    removeRule(set, 'allow', 'A');
    expect(set.allow).toEqual(['A']);
  });
});

describe('replaceRule (edição = remover a antiga + adicionar a nova)', () => {
  it('troca o texto mantendo o mesmo behavior', () => {
    const set: PermissionRuleSet = { allow: ['Bash(ls *)'], ask: [], deny: [] };
    expect(replaceRule(set, 'allow', 'Bash(ls *)', 'allow', 'Bash(ls -la *)')).toEqual({ allow: ['Bash(ls -la *)'], ask: [], deny: [] });
  });
  it('move de um behavior pra outro (ex.: allow -> deny)', () => {
    const set: PermissionRuleSet = { allow: ['Bash(rm -rf *)'], ask: [], deny: [] };
    expect(replaceRule(set, 'allow', 'Bash(rm -rf *)', 'deny', 'Bash(rm -rf *)')).toEqual({ allow: [], ask: [], deny: ['Bash(rm -rf *)'] });
  });
  it('regra antiga já não existe mais: ainda assim adiciona a nova (idempotente)', () => {
    const set = emptyRuleSet();
    expect(replaceRule(set, 'allow', 'sumiu', 'ask', 'Nova')).toEqual({ allow: [], ask: ['Nova'], deny: [] });
  });
});

describe('readPermissionRuleSet + writePermissionRuleSet (I/O real, tmp dir)', () => {
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'orion-permrules-'));
    try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('arquivo inexistente: set vazio, sem erro (ENOENT tolerado)', async () => withTmpDir(async (dir) => {
    const r = await readPermissionRuleSet(path.join(dir, '.claude', 'settings.json'));
    expect(r).toEqual({ set: { allow: [], ask: [], deny: [] } });
  }));

  it('escreve e relê um set (round-trip)', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    const set: PermissionRuleSet = { allow: ['Bash(ls *)'], ask: ['WebFetch'], deny: [] };
    await writePermissionRuleSet(file, set);
    const r = await readPermissionRuleSet(file);
    expect(r).toEqual({ set });
  }));

  it('escreve criando a pasta .claude quando ela ainda não existe', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    await writePermissionRuleSet(file, { allow: ['X'], ask: [], deny: [] });
    const r = await readPermissionRuleSet(file);
    expect(r.set.allow).toEqual(['X']);
  }));

  it('preserva outras chaves já existentes no arquivo ao escrever', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    await writePermissionRuleSet(file, { allow: [], ask: [], deny: [] });
    // simula um settings.json com outras chaves, escrito por fora (ex.: pelo próprio CLI)
    const { writeFile, readFile } = await import('node:fs/promises');
    const current = JSON.parse(await readFile(file, 'utf8'));
    current.model = 'sonnet';
    await writeFile(file, JSON.stringify(current, null, 2));
    await writePermissionRuleSet(file, { allow: ['Bash(ls *)'], ask: [], deny: [] });
    const final = JSON.parse(await readFile(file, 'utf8'));
    expect(final.model).toBe('sonnet');
    expect(final.permissions.allow).toEqual(['Bash(ls *)']);
  }));

  it('JSON inválido existente: readPermissionRuleSet devolve erro + set vazio (não lança)', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ isso não é json válido');
    const r = await readPermissionRuleSet(file);
    expect(r.set).toEqual({ allow: [], ask: [], deny: [] });
    expect(r.error).toBeDefined();
  }));

  it('JSON inválido existente: writePermissionRuleSet RECUSA sobrescrever (nunca perde o resto do arquivo por engano)', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    const original = '{ isso não é json válido';
    await writeFile(file, original);
    await expect(writePermissionRuleSet(file, { allow: ['X'], ask: [], deny: [] })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(original);
  }));
});

describe('mutatePermissionRuleSet (orquestra ler -> mutar -> escrever -> devolver)', () => {
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'orion-permrules-'));
    try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('lê, aplica a mutação pura e escreve, devolvendo o novo set', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    const set = await mutatePermissionRuleSet(file, (s) => addRule(s, 'deny', 'Bash(rm -rf *)'));
    expect(set).toEqual({ allow: [], ask: [], deny: ['Bash(rm -rf *)'] });
    const r = await readPermissionRuleSet(file);
    expect(r.set).toEqual(set);
  }));

  it('duas mutações em sequência acumulam', async () => withTmpDir(async (dir) => {
    const file = path.join(dir, '.claude', 'settings.json');
    await mutatePermissionRuleSet(file, (s) => addRule(s, 'allow', 'A'));
    const set = await mutatePermissionRuleSet(file, (s) => addRule(s, 'allow', 'B'));
    expect(set.allow).toEqual(['A', 'B']);
  }));
});
