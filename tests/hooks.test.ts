import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeHookCommand, parseHooksFromSettings, readProjectHooks, HOOK_SOURCE_LABEL } from '../server/claude/hooks.js';

/**
 * Regras extraídas lendo o webview decompilado da extensão real (v2.1.283,
 * `/srv/orion-reference-2.1.283/webview/index.js` — ver PARIDADE.md): a lista de hooks vem de
 * `settings.json` no formato `{ hooks: { <evento>: [ { matcher?, hooks: [...] } ] } }` (função `r95`);
 * o texto de exibição de cada hook varia por `type` (função `n95`): command → comando+args, prompt/
 * agent → prompt, http → url, mcp_tool → "servidor/tool".
 */
describe('describeHookCommand — texto de exibição por tipo (mesma lógica de n95 real)', () => {
  it('command sem args', () => {
    expect(describeHookCommand({ type: 'command', command: 'echo oi' })).toBe('echo oi');
  });
  it('command com args', () => {
    expect(describeHookCommand({ type: 'command', command: 'echo', args: ['a', 'b'] })).toBe('echo a b');
  });
  it('prompt', () => {
    expect(describeHookCommand({ type: 'prompt', prompt: 'Isso é seguro?' })).toBe('Isso é seguro?');
  });
  it('agent (mesmo campo de prompt)', () => {
    expect(describeHookCommand({ type: 'agent', prompt: 'Verifique X' })).toBe('Verifique X');
  });
  it('http', () => {
    expect(describeHookCommand({ type: 'http', url: 'https://example.com/hook' })).toBe('https://example.com/hook');
  });
  it('mcp_tool', () => {
    expect(describeHookCommand({ type: 'mcp_tool', server: 'meu-servidor', tool: 'minha-tool' })).toBe('meu-servidor/minha-tool');
  });
  it('script', () => {
    expect(describeHookCommand({ type: 'script', file: '/caminho/script.sh' })).toBe('/caminho/script.sh');
  });
  it('tipo desconhecido nunca lança — cai num JSON defensivo', () => {
    expect(() => describeHookCommand({ type: 'algo-novo-do-futuro', foo: 'bar' } as any)).not.toThrow();
    expect(describeHookCommand({ type: 'algo-novo-do-futuro', foo: 'bar' } as any)).toContain('foo');
  });
});

describe('parseHooksFromSettings — achata settings.hooks no formato real', () => {
  it('settings sem hooks: lista vazia', () => {
    expect(parseHooksFromSettings('project', {})).toEqual([]);
    expect(parseHooksFromSettings('project', null)).toEqual([]);
    expect(parseHooksFromSettings('project', 'string qualquer')).toEqual([]);
  });
  it('um evento, um matcher, um hook', () => {
    const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo oi' }] }] } };
    const rows = parseHooksFromSettings('project', settings);
    expect(rows).toEqual([{ event: 'PreToolUse', matcher: 'Bash', type: 'command', description: 'echo oi', source: 'project', disabled: false, timeout: undefined }]);
  });
  it('matcher ausente vira string vazia (== "(all)")', () => {
    const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] } };
    const rows = parseHooksFromSettings('user', settings);
    expect(rows[0].matcher).toBe('');
    expect(rows[0].source).toBe('user');
  });
  it('vários hooks no mesmo grupo e vários grupos no mesmo evento', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'c' }] },
        ],
      },
    };
    const rows = parseHooksFromSettings('project', settings);
    expect(rows.map(r => r.description)).toEqual(['a', 'b', 'c']);
  });
  it('hook com disabled:true e timeout numérico', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', disabled: true, timeout: 30 }] }] } };
    const rows = parseHooksFromSettings('project', settings);
    expect(rows[0].disabled).toBe(true);
    expect(rows[0].timeout).toBe(30);
  });
  it('defensivo: grupo sem array de hooks, evento sem array de grupos — nunca lança', () => {
    expect(() => parseHooksFromSettings('project', { hooks: { X: 'não é array' } })).not.toThrow();
    expect(parseHooksFromSettings('project', { hooks: { X: 'não é array' } })).toEqual([]);
    expect(() => parseHooksFromSettings('project', { hooks: { X: [{ matcher: 'a' }] } })).not.toThrow();
    expect(parseHooksFromSettings('project', { hooks: { X: [{ matcher: 'a' }] } })).toEqual([]);
  });
});

describe('readProjectHooks — lê os 3 arquivos reais de settings.json do projeto/local/usuário', () => {
  async function withTmp(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), 'orion-hooks-test-'));
    try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('nenhum arquivo existe: lista vazia, sem erro', async () => withTmp(async (dir) => {
    const projectPath = path.join(dir, 'proj');
    await mkdir(projectPath, { recursive: true });
    const homeDir = path.join(dir, 'home-vazio');
    const listing = await readProjectHooks(projectPath, homeDir);
    expect(listing.hooks).toEqual([]);
    expect(listing.errors).toEqual([]);
    expect(listing.disableAllHooks).toBe(false);
  }));

  it('junta hooks de projeto + local + usuário, cada um com o source certo', async () => withTmp(async (dir) => {
    const projectPath = path.join(dir, 'proj');
    const claudeDir = path.join(projectPath, '.claude');
    const homeDir = path.join(dir, 'home');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'do-projeto' }] }] } }));
    await writeFile(path.join(claudeDir, 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'do-local' }] }] } }));
    await writeFile(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'do-usuario' }] }] } }));
    const listing = await readProjectHooks(projectPath, homeDir);
    expect(listing.hooks.map(h => [h.source, h.description]).sort()).toEqual([
      ['local', 'do-local'],
      ['project', 'do-projeto'],
      ['user', 'do-usuario'],
    ].sort());
    expect(listing.loadedByOrion).toEqual(['project', 'user']);
  }));

  it('JSON inválido num arquivo vira erro, sem derrubar os outros', async () => withTmp(async (dir) => {
    const projectPath = path.join(dir, 'proj');
    const claudeDir = path.join(projectPath, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, 'settings.json'), '{ isso não é json');
    await writeFile(path.join(claudeDir, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'ok' }] }] } }));
    const listing = await readProjectHooks(projectPath, path.join(dir, 'home-vazio'));
    expect(listing.errors).toHaveLength(1);
    expect(listing.errors[0].source).toBe('project');
    expect(listing.hooks).toEqual([{ event: 'Stop', matcher: '', type: 'command', description: 'ok', source: 'local', disabled: false, timeout: undefined }]);
  }));

  it('disableAllHooks:true em qualquer arquivo liga a flag', async () => withTmp(async (dir) => {
    const projectPath = path.join(dir, 'proj');
    const claudeDir = path.join(projectPath, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
    const listing = await readProjectHooks(projectPath, path.join(dir, 'home-vazio'));
    expect(listing.disableAllHooks).toBe(true);
  }));
});

describe('HOOK_SOURCE_LABEL — rótulos pra tela', () => {
  it('tem os 3 rótulos', () => {
    expect(HOOK_SOURCE_LABEL.project).toBeTruthy();
    expect(HOOK_SOURCE_LABEL.local).toBeTruthy();
    expect(HOOK_SOURCE_LABEL.user).toBeTruthy();
  });
});
