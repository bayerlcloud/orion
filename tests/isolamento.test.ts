import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acharWrapper, binarioDoSdk, comandoPararScope, dicaMemoria, envDoGerente, isolamentoDaSessao, unidadeDaSessao, WRAPPER } from '../server/claude/isolamento';

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
  it('wrapper sem bus do usuário avisa no stderr e roda o binário direto, com os mesmos argumentos', () => {
    const r = spawnSync(wrapper, ['%s\n', 'a', 'b c'], { encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', ORION_CLAUDE_BIN: '/usr/bin/printf', ORION_SESSION_ID: 's',
      XDG_RUNTIME_DIR: '/nao-existe', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nao-existe/bus',
    } });
    expect(r.stdout).toBe('a\nb c\n');
    expect(r.stderr).toContain('claude-scope: sem systemd-run/bus, rodando direto');
  });
  it('wrapper com systemd-run: teto padrão 4G/3G, OOMPolicy=continue, slice e unit da sessão; override por env', () => {
    // systemd-run e systemctl falsos na frente do PATH: o primeiro só imprime os argumentos.
    const dir = mkdtempSync(path.join(tmpdir(), 'scope-'));
    writeFileSync(path.join(dir, 'systemd-run'), '#!/bin/sh\nprintf "%s\\n" "$@"\n'); writeFileSync(path.join(dir, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(dir, 'systemd-run'), 0o755); chmodSync(path.join(dir, 'systemctl'), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, ORION_CLAUDE_BIN: '/nm/claude', ORION_SESSION_ID: '0f3a9c2e-1111-2222-3333-444444444444' };
    const args = execFileSync(wrapper, ['--resume=x'], { encoding: 'utf8', env }).trimEnd().split('\n');
    expect(args.slice(0, 4)).toEqual(['--user', '--scope', '--quiet', '--collect']);
    expect(args.find(a => a.startsWith('--unit='))).toMatch(/^--unit=orion-sessao-0f3a9c2e-\d+$/);
    expect(args).toContain('--slice=orion-sessoes.slice');
    expect(args).toContain('MemoryMax=4G'); expect(args).toContain('MemoryHigh=3G'); expect(args).toContain('CPUWeight=80'); expect(args).toContain('OOMPolicy=continue');
    expect(args.slice(-3)).toEqual(['--', '/nm/claude', '--resume=x']);
    const custom = execFileSync(wrapper, [], { encoding: 'utf8', env: { ...env, ORION_SESSAO_MEMMAX: '8G', ORION_SESSAO_MEMHIGH: '6G' } });
    expect(custom).toContain('MemoryMax=8G'); expect(custom).toContain('MemoryHigh=6G');
  });
  it('parar scopes: unit da sessão como o wrapper deriva, glob por pid, env do gerente', () => {
    expect(unidadeDaSessao('0f3a9c2e-1111-2222-3333-444444444444')).toBe('orion-sessao-0f3a9c2e');
    expect(unidadeDaSessao('Sítio!Novo')).toBe('orion-sessao-StioNovo');
    expect(unidadeDaSessao('---')).toBe('orion-sessao-x');
    expect(comandoPararScope('orion-sessao-0f3a9c2e-*')).toEqual({ cmd: 'systemctl', args: ['--user', 'stop', '--', 'orion-sessao-0f3a9c2e-*'] });
    expect(envDoGerente({ PATH: '/usr/bin' }, 1001)).toEqual({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1001', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus' });
    expect(envDoGerente({ XDG_RUNTIME_DIR: '/run/user/7', DBUS_SESSION_BUS_ADDRESS: 'x' }, 1001)).toEqual({ XDG_RUNTIME_DIR: '/run/user/7', DBUS_SESSION_BUS_ADDRESS: 'x' });
  });
  it('processo morto por sinal ganha a dica do teto de memória; outros erros ficam como estão', () => {
    expect(dicaMemoria('Claude Code process terminated by signal SIGTERM')).toBe('Claude Code process terminated by signal SIGTERM\npossível teto de memória da sessão (ORION_SESSAO_MEMMAX)');
    expect(dicaMemoria('Claude Code process exited with code 1')).toBe('Claude Code process exited with code 1');
  });
});
