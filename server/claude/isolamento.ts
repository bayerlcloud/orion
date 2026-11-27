import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Isolamento do processo `claude` de cada sessão (27/11/2026). Lançado pelo SDK como filho do painel, o
 * claude e tudo que ele roda (tsc de 900 MB, vite build de 5 GB) entram no cgroup do orion-central
 * (MemoryHigh=6G) e estrangulam o painel inteiro. Agora o SDK é apontado pra deploy/claude-scope.sh, que
 * registra um scope do gerente de usuário (`systemd-run --user --scope`, fora do cgroup do serviço) com
 * teto de memória por sessão e faz `exec` do binário real, mesmo pid. Mesmo precedente do deploy.sh
 * (comandoIsolado em server/integracao/turno.ts). Desligável com ORION_SESSAO_ISOLADA=0.
 * ponytail: teto fixo por env (4G/3G); vira meta do projeto se alguma sessão precisar de mais.
 */

export const WRAPPER = path.join('deploy', 'claude-scope.sh');

/** Sobe a árvore a partir de `inicio` até achar deploy/claude-scope.sh (código em server/claude, build em dist/server/claude). */
export function acharWrapper(inicio: string, existe: (p: string) => boolean = existsSync): string | null {
  let dir = path.resolve(inicio);
  for (;;) {
    const p = path.join(dir, WRAPPER);
    if (existe(p)) return p;
    const pai = path.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

/** Binário nativo do SDK pra esta plataforma (o mesmo que o SDK usaria sozinho). */
export function binarioDoSdk(resolve: (id: string) => string = createRequire(import.meta.url).resolve): string | null {
  try { return resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`); } catch { return null; }
}

/** process.env só com strings (o `env` do SDK e do execFile não aceitam undefined). */
export const envStrings = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));

/** Env pra falar com o gerente de usuário (systemd --user) do uid: respeita XDG/DBUS já presentes. */
export function envDoGerente(env: Record<string, string>, uid: number): Record<string, string> {
  return { ...env, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus` };
}

/** Prefixo da unit da sessão: mesma derivação do wrapper (primeiro bloco do uuid, só [a-zA-Z0-9], até 12). */
export function unidadeDaSessao(sessionId: string): string {
  return `orion-sessao-${sessionId.split('-')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'x'}`;
}

/** `systemctl --user stop <padrão>`: glob porque o nome da unit termina no pid, que o SDK não expõe. */
export function comandoPararScope(padrao: string): { cmd: string; args: string[] } {
  return { cmd: 'systemctl', args: ['--user', 'stop', '--', padrao] };
}

/**
 * Para (e coleta) os scopes que casam com o padrão. Usado no Parar/watchdog de uma sessão (o claude
 * morto por TERM deixava filhos órfãos vivos no scope, ex. um build) e no boot/SIGTERM do painel
 * (antes, KillMode=control-group matava os claude junto; agora eles vivem no gerente do usuário e
 * seguiriam o turno com o stdin fechado, sem ninguém ouvindo). Erro vira só log.
 */
export function pararScopes(padrao: string, env: Record<string, string>, log?: (m: string) => void): Promise<void> {
  if (process.env.ORION_SESSAO_ISOLADA === '0') return Promise.resolve();
  const c = comandoPararScope(padrao);
  return new Promise((resolve) => execFile(c.cmd, c.args, { env, timeout: 10_000 }, (err, _so, se) => {
    if (err) log?.(`scopes ${padrao}: não parou (${String(se || err.message).trim().slice(0, 200)})`);
    resolve();
  }));
}

/** Processo morto por sinal dentro do scope: provável estouro do teto de memória da sessão. */
export function dicaMemoria(msg: string): string {
  return /signal SIG/.test(msg) ? `${msg}\npossível teto de memória da sessão (ORION_SESSAO_MEMMAX)` : msg;
}

export type Isolamento = { pathToClaudeCodeExecutable: string; env: Record<string, string> } | { erro: string };

/**
 * Opções extras pro `query()` do SDK: wrapper como executável e env com o que o wrapper precisa.
 * `env` é a base que iria pro SDK (p.env; sem ela, process.env), porque o SDK não mistura com process.env sozinho.
 */
export function isolamentoDaSessao(sessionId: string, env: Record<string, string> | undefined, o: { isolar?: boolean; uid?: number; wrapper?: string | null; bin?: string | null } = {}): Isolamento | null {
  if (!(o.isolar ?? process.env.ORION_SESSAO_ISOLADA !== '0')) return null;
  const wrapper = o.wrapper === undefined ? acharWrapper(path.dirname(fileURLToPath(import.meta.url))) ?? acharWrapper(process.cwd()) : o.wrapper;
  if (!wrapper) return { erro: `${WRAPPER} não encontrado` };
  const bin = o.bin === undefined ? binarioDoSdk() : o.bin;
  if (!bin) return { erro: 'binário nativo do SDK não encontrado' };
  const uid = o.uid ?? process.getuid?.() ?? 0;
  return { pathToClaudeCodeExecutable: wrapper, env: { ...envDoGerente(env ?? envStrings(), uid), ORION_CLAUDE_BIN: bin, ORION_SESSION_ID: sessionId } };
}
