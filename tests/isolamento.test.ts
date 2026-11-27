import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { acharWrapper, binarioDoSdk, isolamentoDaSessao, WRAPPER } from '../server/claude/isolamento';

const raiz = path.resolve(__dirname, '..');
const wrapper = path.join(raiz, WRAPPER);

describe('isolamento da sessão: claude fora do cgroup do painel (27/11/2026)', () => {
  it('acha deploy/claude-scope.sh subindo a árvore, tanto do código quanto do build', () => {
    const existe = (p: string) => p === '/srv/x/deploy/claude-scope.sh';
    expect(acharWrapper('/srv/x/server/claude', existe)).toBe('/srv/x/deploy/claude-scope.sh');
    expect(acharWrapper('/srv/x/dist/server/claude', existe)).toBe('/srv/x/deploy/claude-scope.sh');
    expect(acharWrapper('/srv/y/dist/server/claude', existe)).toBeNull();
  });
  it('o wrapper existe no repo e é executável', () => {
    expect(acharWrapper(path.join(raiz, 'server', 'claude'))).toBe(wrapper);
    expect(statSync(wrapper).mode & 0o111).toBeTruthy();
  });
  it('binário do SDK: pacote nativo da plataforma', () => {
    expect(binarioDoSdk((id) => `/nm/${id}`)).toBe(`/nm/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    expect(binarioDoSdk(() => { throw new Error('x'); })).toBeNull();
    if (process.platform === 'linux') expect(statSync(binarioDoSdk()!).mode & 0o111).toBeTruthy();
  });
  it('monta executável e env pro SDK; respeita XDG/DBUS já presentes', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/danilo' };
    const r = isolamentoDaSessao('0f3a9c2e-1111-2222-3333-444444444444', base, { isolar: true, uid: 1001, wrapper: '/w/deploy/claude-scope.sh', bin: '/nm/claude' });
    expect(r).toEqual({ pathToClaudeCodeExecutable: '/w/deploy/claude-scope.sh', env: {
      PATH: '/usr/bin', HOME: '/home/danilo', ORION_CLAUDE_BIN: '/nm/claude', ORION_SESSION_ID: '0f3a9c2e-1111-2222-3333-444444444444',
      XDG_RUNTIME_DIR: '/run/user/1001', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
    } });
    const r2 = isolamentoDaSessao('s', { ...base, XDG_RUNTIME_DIR: '/run/user/7' }, { isolar: true, uid: 1001, wrapper: '/w', bin: '/b' });
    expect((r2 as { env: Record<string, string> }).env.XDG_RUNTIME_DIR).toBe('/run/user/7');
    expect(base).toEqual({ PATH: '/usr/bin', HOME: '/home/danilo' });
  });
  it('sem p.env parte do process.env; desligado vira null; sem wrapper ou binário vira erro', () => {
    const r = isolamentoDaSessao('s', undefined, { isolar: true, uid: 1, wrapper: '/w', bin: '/b' }) as { env: Record<string, string> };
    expect(r.env.PATH).toBe(process.env.PATH);
    expect(isolamentoDaSessao('s', {}, { isolar: false })).toBeNull();
    expect(isolamentoDaSessao('s', {}, { isolar: true, wrapper: null })).toEqual({ erro: `${WRAPPER} não encontrado` });
    expect(isolamentoDaSessao('s', {}, { isolar: true, wrapper: '/w', bin: null })).toEqual({ erro: 'binário nativo do SDK não encontrado' });
  });
  it('wrapper sem bus do usuário roda o binário direto, com os mesmos argumentos', () => {
    const out = execFileSync(wrapper, ['%s\n', 'a', 'b c'], { encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', ORION_CLAUDE_BIN: '/usr/bin/printf', ORION_SESSION_ID: 's',
      XDG_RUNTIME_DIR: '/nao-existe', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nao-existe/bus',
    } });
    expect(out).toBe('a\nb c\n');
  });
});
