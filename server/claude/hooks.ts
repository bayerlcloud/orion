import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * "Aba Claude" — painel de skills + lista de hooks (ver PARIDADE.md, seção 13, itens 10/11).
 *
 * SÓ LEITURA de propósito — decisão de segurança, não uma limitação de tempo. A extensão real (lida
 * em `/srv/orion-reference-2.1.283/webview/index.js` — funções `Y35`/`Q35`/`RA1`/`vH0`) tem um editor
 * de hooks completo (add/editar/remover), mas ele nunca escreve o arquivo direto do webview: cada
 * ação vira um control-request (`{type:"edit_hook", op:"add"|"replace"|"remove", ...}`) mandado pro
 * processo `claude` CLI já rodando na mesma janela do VS Code, que valida e escreve o
 * `settings.json` ele mesmo — inclusive respeitando `disableAllHooks`/`allowManagedHooksOnly`/
 * políticas de organização antes de aceitar.
 *
 * O Orion não tem esse canal: `server/claude/runner.ts` só guarda uma `Query` viva ENQUANTO um turno
 * está rodando (`Live.query`, limpa no `finally` de `run()`) — não existe um processo `claude` parado
 * à espera de comandos de edição de settings fora de um turno. Mesmo se houvesse, um hook do tipo
 * `command` é um COMANDO DE SHELL ARBITRÁRIO que passa a rodar sozinho, sem confirmação, em toda
 * sessão futura que tocar este projeto (a nossa própria, via `settingSources:['user','project']` em
 * `runner.ts` — E a de qualquer humano que abrir este repo no terminal depois). Numa extensão local
 * de um único usuário isso já é um contrato de confiança (é o dono da própria máquina); no Orion —
 * painel MULTI-USUÁRIO em produção — permitir que qualquer pessoa logada plante um hook (ex. um
 * `SessionStart` que roda `curl … | sh`) que depois executa sozinho pra TODO MUNDO que usar o projeto
 * é uma escalação de privilégio real, categoricamente diferente do risco que a extensão assume.
 * Por isso: lista, agrupada por evento/matcher, igual à tela real — sem adicionar/editar/remover.
 *
 * Fonte dos dados: os 3 arquivos `settings.json` que podem ter uma seção `hooks` (mesmo formato real,
 * função `r95` do webview: `{ hooks: { <evento>: [ { matcher?, hooks: [...] } ] } }`) — projeto
 * (`.claude/settings.json`), local (`.claude/settings.local.json`, não versionado) e usuário
 * (`~/.claude/settings.json` do processo Orion, `danilo` — compartilhado entre todos os projetos).
 * Managed/policy (organização) e hooks de plugin não são lidos: o Orion não tem esse conceito de
 * "settings gerenciado por org" nem um marketplace de plugins ainda (ver PARIDADE.md seção 13, item
 * 3, "não construído nesta rodada") — fora de escopo aqui também.
 */

export type HookSourceKind = 'project' | 'local' | 'user';

export const HOOK_SOURCE_LABEL: Record<HookSourceKind, string> = {
  project: 'Projeto',
  local: 'Local',
  user: 'Usuário',
};

export const HOOK_SOURCE_FILE: Record<HookSourceKind, string> = {
  project: '.claude/settings.json',
  local: '.claude/settings.local.json',
  user: '~/.claude/settings.json',
};

/** Fontes que as sessões do Orion realmente carregam hoje (`server/claude/runner.ts`, `settingSources: ['user','project']`) — 'local' fica de fora; a tela avisa quando um hook só existe lá. */
export const HOOKS_LOADED_BY_ORION: HookSourceKind[] = ['project', 'user'];

export type HookConfig = {
  type?: string;
  command?: string;
  args?: string[];
  prompt?: string;
  url?: string;
  server?: string;
  tool?: string;
  file?: string;
  script?: string;
  timeout?: number;
  disabled?: boolean;
  [k: string]: unknown;
};

export type HookEntry = {
  event: string;
  matcher: string;
  type: string;
  description: string;
  source: HookSourceKind;
  disabled: boolean;
  timeout?: number;
};

/**
 * Texto de exibição de um hook, por tipo — mesma lógica da função real `n95` do webview decompilado
 * (v2.1.283): `command` → comando (+ args, se houver); `prompt`/`agent` → o prompt; `http` → a URL;
 * `mcp_tool` → "servidor/tool"; `script` → o arquivo/script. Formato desconhecido (versão futura do
 * schema, ou hook malformado) nunca lança — cai num `JSON.stringify` defensivo.
 */
export function describeHookCommand(hook: HookConfig): string {
  switch (hook.type) {
    case 'command':
      return hook.args && hook.args.length ? [hook.command, ...hook.args].join(' ') : (hook.command ?? '');
    case 'prompt':
    case 'agent':
      return hook.prompt ?? '';
    case 'http':
      return hook.url ?? '';
    case 'mcp_tool':
      return `${hook.server ?? '?'}/${hook.tool ?? '?'}`;
    case 'script':
      return hook.file ?? hook.script ?? '';
    default:
      try { return JSON.stringify(hook); } catch { return String(hook); }
  }
}

/**
 * Achata `settings.hooks` (já parseado de JSON) na lista de linhas que a tela mostra — mesma forma
 * real confirmada lendo `r95` no webview decompilado v2.1.283. Defensivo em cada nível: `settings`
 * não-objeto, `hooks` ausente/não-objeto, evento cujo valor não é array, grupo sem `hooks` array —
 * tudo isso é ignorado silenciosamente, nunca lança.
 */
export function parseHooksFromSettings(source: HookSourceKind, settings: unknown): HookEntry[] {
  const out: HookEntry[] = [];
  if (!settings || typeof settings !== 'object') return out;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const matcher = typeof (group as Record<string, unknown>).matcher === 'string' ? (group as Record<string, unknown>).matcher as string : '';
      const list = Array.isArray((group as Record<string, unknown>).hooks) ? (group as Record<string, unknown>).hooks as unknown[] : [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const hook = raw as HookConfig;
        out.push({
          event,
          matcher,
          type: typeof hook.type === 'string' ? hook.type : 'command',
          description: describeHookCommand(hook),
          source,
          disabled: hook.disabled === true,
          timeout: typeof hook.timeout === 'number' ? hook.timeout : undefined,
        });
      }
    }
  }
  return out;
}

export type HookFileError = { source: HookSourceKind; file: string; message: string };
export type HookListing = {
  hooks: HookEntry[];
  errors: HookFileError[];
  disableAllHooks: boolean;
  loadedByOrion: HookSourceKind[];
};

async function readSettingsFile(file: string): Promise<{ json: unknown; error?: string }> {
  let raw: string;
  try { raw = await readFile(file, 'utf-8'); } catch { return { json: undefined }; } // arquivo ausente: comum, silencioso
  try { return { json: JSON.parse(raw) }; }
  catch (e) { return { json: undefined, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Lê os hooks configurados pro projeto — só leitura, ver comentário de topo do arquivo. `homeDir`
 * injetável (padrão `homedir()`) só pra teste.
 */
export async function readProjectHooks(projectPath: string, homeDir: string = homedir()): Promise<HookListing> {
  const files: { source: HookSourceKind; path: string }[] = [
    { source: 'project', path: path.join(projectPath, '.claude', 'settings.json') },
    { source: 'local', path: path.join(projectPath, '.claude', 'settings.local.json') },
    { source: 'user', path: path.join(homeDir, '.claude', 'settings.json') },
  ];
  const hooks: HookEntry[] = [];
  const errors: HookFileError[] = [];
  let disableAllHooks = false;
  for (const f of files) {
    const { json, error } = await readSettingsFile(f.path);
    if (error) { errors.push({ source: f.source, file: f.path, message: error }); continue; }
    if (!json) continue;
    if ((json as Record<string, unknown>)?.disableAllHooks === true) disableAllHooks = true;
    hooks.push(...parseHooksFromSettings(f.source, json));
  }
  return { hooks, errors, disableAllHooks, loadedByOrion: HOOKS_LOADED_BY_ORION };
}
