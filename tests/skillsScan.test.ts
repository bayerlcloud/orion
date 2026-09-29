import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classificarAtivacao, fonteDe, marcarDuplicadas, parseFrontmatter, scanRaiz, sinais, type SkillItem,
} from '../server/tools/skillsScan';

describe('frontmatter', () => {
  it('lê chave: valor, aspas e bloco |', () => {
    const { fm, body } = parseFrontmatter('---\nname: x\ndescription: "Use when \\"foo\\""\nnotas: |\n  linha 1\n  linha 2\nmetadata:\n  version: 2\n---\n# corpo\n');
    expect(fm.name).toBe('x');
    expect(fm.description).toBe('Use when "foo"');
    expect(fm.notas).toBe('linha 1\nlinha 2');
    expect(body).toBe('# corpo\n');
  });
  it('sem frontmatter vira vazio', () => {
    expect(parseFrontmatter('# só corpo').fm).toEqual({});
  });
});

describe('ativação', () => {
  it('padrão é automática; disable-model-invocation vira manual; user-invocable false vira só modelo', () => {
    expect(classificarAtivacao('skill', {})).toBe('auto');
    expect(classificarAtivacao('command', { 'disable-model-invocation': 'true' })).toBe('manual');
    expect(classificarAtivacao('skill', { 'user-invocable': 'false' })).toBe('modelo');
    expect(classificarAtivacao('agent', {})).toBe('modelo');
    expect(classificarAtivacao('hook', {})).toBe('sempre');
  });
});

describe('sinais e fonte', () => {
  it('detecta caminho do code-server e credencial', () => {
    expect(sinais('Rode bash /config/.local/bin/devproj')).toEqual({ refs_code_server: true, credencial: false });
    expect(sinais('a senha do basic_auth (x / y)').credencial).toBe(true);
    expect(sinais('token ghp_' + 'a'.repeat(30)).credencial).toBe(true);
    expect(sinais('texto normal').credencial).toBe(false);
  });
  it('classifica plugin de cache, local, sincronizado e solto', () => {
    expect(fonteDe('plugins/cache/superpowers-dev/superpowers/5.1.0/skills/tdd/SKILL.md')).toEqual({ plugin: 'superpowers', fonte: 'plugin: superpowers', marketplace: 'superpowers-dev' });
    expect(fonteDe('plugins/local/bayerl/1.0.0/skills/siteexpress/SKILL.md').fonte).toBe('plugin local: bayerl');
    expect(fonteDe('plugins/synced/bucket/claude-mem~g2/skills/do/SKILL.md')).toMatchObject({ plugin: 'claude-mem', fonte: 'claude.ai (sincronizado)' });
    expect(fonteDe('skills/synced/bucket/pdf/SKILL.md').fonte).toBe('claude.ai (sincronizado)');
    expect(fonteDe('commands/riper/plan.md').fonte).toBe('usuário');
  });
});

describe('duplicadas', () => {
  const base = (o: Partial<SkillItem>): SkillItem => ({
    id: 'x', kind: 'skill', invocacao: 'pdf', name: 'pdf', description: '', origem: 'c3', fonte: '', plugin: null, ativacao: 'auto',
    habilitada: true, path: '', bytes: 0, refs_code_server: false, credencial: false, argument_hint: null, allowed_tools: null,
    model: null, duplicada_de: null, descricao_pt: null, ...o,
  });
  it('cópia do code-server aponta para a ativa na c3; a da c3 nunca é marcada', () => {
    const r = marcarDuplicadas([base({ id: 'a' }), base({ id: 'b', origem: 'code-server' }), base({ id: 'c', origem: 'code-server', invocacao: 'outra' })]);
    expect(r.map(i => i.duplicada_de)).toEqual([null, 'a', null]);
  });
});

describe('varredura de disco', () => {
  it('acha skill, command aninhado, agent e plugin (ligado/desligado), e hooks do settings saneado', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-'));
    try {
      await mkdir(path.join(dir, 'skills/minha'), { recursive: true });
      await writeFile(path.join(dir, 'skills/minha/SKILL.md'), '---\nname: minha\ndescription: Use when testing\n---\ncorpo');
      await mkdir(path.join(dir, 'commands/riper'), { recursive: true });
      await writeFile(path.join(dir, 'commands/riper/plan.md'), '---\ndescription: plano\ndisable-model-invocation: true\n---\nRode bash /config/.local/bin/x');
      await mkdir(path.join(dir, 'agents'), { recursive: true });
      await writeFile(path.join(dir, 'agents/review.md'), '---\nname: review\ndescription: revisa\ntools: Read\nmodel: sonnet\n---\n');
      await mkdir(path.join(dir, 'plugins/cache/mk/sp/1.0/skills/tdd'), { recursive: true });
      await writeFile(path.join(dir, 'plugins/cache/mk/sp/1.0/skills/tdd/SKILL.md'), '---\nname: tdd\ndescription: d\n---\n');
      await mkdir(path.join(dir, 'plugins/cache/mk/off/1.0/skills/z'), { recursive: true });
      await writeFile(path.join(dir, 'plugins/cache/mk/off/1.0/skills/z/SKILL.md'), '---\nname: z\n---\n');
      await mkdir(path.join(dir, 'skills/minha/references'), { recursive: true });
      await writeFile(path.join(dir, 'skills/minha/references/x.md'), '# não é skill');
      await writeFile(path.join(dir, 'settings.sanitized.json'), JSON.stringify({ enabledPlugins: { 'sp@mk': true }, hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'python3 /config/.claude/hooks/x.py' }] }] } }));

      const itens = await scanRaiz({ origem: 'code-server', dir, rotulo: 'code-server' });
      const por = Object.fromEntries(itens.map(i => [i.invocacao, i]));
      expect(Object.keys(por).sort()).toEqual(['SessionStart', 'minha', 'off:z', 'review', 'riper:plan', 'sp:tdd']);
      expect(por.minha).toMatchObject({ kind: 'skill', ativacao: 'auto', habilitada: true, fonte: 'usuário' });
      expect(por['riper:plan']).toMatchObject({ kind: 'command', ativacao: 'manual', refs_code_server: true });
      expect(por.review).toMatchObject({ kind: 'agent', ativacao: 'modelo', allowed_tools: 'Read', model: 'sonnet' });
      expect(por['sp:tdd']).toMatchObject({ plugin: 'sp', habilitada: true });
      expect(por['off:z']).toMatchObject({ plugin: 'off', habilitada: false });
      expect(por.SessionStart).toMatchObject({ kind: 'hook', ativacao: 'sempre', refs_code_server: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('raiz inexistente vira lista vazia, sem lançar', async () => {
    expect(await scanRaiz({ origem: 'projeto', dir: '/nao/existe/.claude', rotulo: 'x' })).toEqual([]);
  });
});
