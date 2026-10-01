import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { sqlDestrutivo } from './sqlGuard.js';
import perigoJson from '../../deploy/root-perigo.json' with { type: 'json' };

/**
 * Política padrão de permissão de TODA sessão do Orion (decisão do Danilo, 29/09/2026):
 * ação comum roda sem perguntar; ação sensível vira o cartão Aprovar/Recusar no chat (o mesmo do
 * `canUseTool` do runner), nunca um bloqueio. Exceção: modo `auto` libera tudo, sem cartão
 * (Danilo, 30/09/2026: "se é Auto é Auto"), menos SQL destrutivo, que pede o cartão em qualquer modo e
 * faz backup antes (Danilo, 30/09/2026, docs/superpowers/specs/2026-09-30-preview-design.md, Parte 3).
 *
 * Entra como hook PreToolUse in-process (runner.ts), que o CLI consulta ANTES do modo e do
 * classificador do modo `auto`: 'allow' pula tudo, 'ask' cai no canUseTool (o botão).
 * Opção A: o que não está na lista de sensíveis roda direto. Falso positivo custa um clique;
 * falso negativo roda sem perguntar, então na dúvida o padrão entra na lista.
 *
 * Guarda-corpo contra engano, não contra um agente malicioso: tudo roda como `danilo`, então um
 * comando ofuscado de propósito passa (risco aceito em DECISOES.md, "sem isolamento").
 */

/** `always`: pergunta até no modo auto (SQL destrutivo, decisão do Danilo em 30/09/2026). `sql`: o SQL, para o backup. */
export type Verdict = { decision: 'allow' | 'ask'; reason?: string; always?: boolean; sql?: string };

/** Backup antes de SQL destrutivo; devolve o texto que vai para o cartão ("backup salvo em ...", "backup falhou: ..."). */
export type BackupFn = (sql: string) => Promise<string>;

const BACKUP_TIMEOUT_MS = 5 * 60_000;

const PUBLICAR = 'publicar em produção';
const BANCO = 'ler ou alterar banco/segredo de produção';
const APAGAR = 'apagar coisas';

const BASH_SENSIVEL: [RegExp, string][] = [
  [/\bdeploy\.sh\b/, PUBLICAR],
  [/\/srv\/builds\/pedido\.json/, PUBLICAR],
  [/\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/, 'git push --force'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D\b|push\s+[^;&|]*--delete\b)/, 'descartar trabalho no git'],
  [/(^|[\s;&|(`"'])(sudo\s+)?(rm|rmdir|shred|unlink)\s/, APAGAR],
  [/\sfind\s[^;&|]*-delete\b|^find\s[^;&|]*-delete\b/, APAGAR],
  [/\bdocker\s+(rm|rmi|volume\s+rm|system\s+prune|compose\s+down\s[^;&|]*-v)\b/, APAGAR],
  [/(-X\s*|--request[\s=]+)DELETE\b/i, APAGAR],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE|DELETE\s+FROM)\b/i, APAGAR],
  [/\b(psql|pg_dump|pg_restore|dropdb)\b|orion-postgres|DATABASE_URL|central\.env/, BANCO],
];

const ARQUIVO_SENSIVEL: [RegExp, string][] = [
  [/^\/srv\/builds\/pedido\.json$/, PUBLICAR],
  [/^\/etc\/orion\//, BANCO],
];

/** MCPs: nome ou `action`/`method` destrutivo, e os que mexem em banco/produção por definição. */
const MCP_NOME_BANCO = /^mcp__supabase__(reset_branch|merge_branch|delete_branch|rebase_branch)$/;
const MCP_SQL = /^mcp__supabase__(execute_sql|apply_migration)$/;
const MCP_NOME_PUBLICAR = /^mcp__coolify__(deploy|redeploy_project|restart_project_apps|stop_all_apps|bulk_env_update|control)$/;
const DESTRUTIVO = /delete|remove|drop|destroy|trash|purge|prune|stop|restart|deploy/i;

/** Root liberado na sessão ("Sim, e liberar root nesta sessão") vale por isto; o helper root confere o mesmo prazo. */
export const ROOT_LIBERADO_HORAS = 8;
const ROOT_PERIGO = perigoJson.padroes.map(([re, motivo]) => [new RegExp(re, 'i'), motivo] as const);
/** Motivo se o comando root é perigoso demais para passar sem cartão mesmo com root liberado; senão null. */
export function rootPerigo(cmd: string): string | null {
  for (const [re, motivo] of ROOT_PERIGO) if (re.test(cmd)) return motivo;
  return null;
}

/**
 * Comandos que publicam o código da pasta atual (deploy de projeto, push direto na main remota).
 * Numa worktree eles publicariam a worktree e pulariam a raiz (incidente do FisioExpert, 01/10/2026).
 */
const PUBLICACAO = /\bdeploy\.sh\b|\bwrangler\b[^;&|]*\bdeploy\b|\bsupabase\s+functions\s+deploy\b|\bvercel\b[^;&|]*--prod\b|\bnetlify\s+deploy\b|\bgit\s+push\b[^;&|]*:(refs\/heads\/)?(main|master)\b/;
export function ehPublicacao(cmd: string): boolean { return PUBLICACAO.test(cmd); }

/** Sessão numa worktree de projeto: `raiz` do projeto e `juntar`, que leva a worktree para a raiz já (null = ok, senão o motivo). */
export type PublicarDaRaiz = { raiz: string; juntar: () => Promise<string | null> };

const escRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** O comando começa entrando na raiz (`cd <raiz> && ...`, com ou sem aspas). */
export function saiDaRaiz(cmd: string, raiz: string): boolean {
  const r = escRe(raiz.replace(/\/+$/, ''));
  return new RegExp(`^\\s*cd\\s+(['"]?)${r}/?\\1\\s*&&`).test(cmd);
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

/**
 * SQL que um comando Bash manda para um banco: só olha comandos com psql, supabase ou pg_restore, e
 * devolve o primeiro trecho destrutivo entre os textos entre aspas e as linhas (cobre `-c "..."` e heredoc).
 */
function sqlDoBash(cmd: string): string {
  if (!/\b(psql|supabase|pg_restore)\b/.test(cmd)) return '';
  const trechos = [...cmd.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[1] ?? m[2] ?? '');
  for (const t of [...trechos, ...cmd.split('\n')]) if (sqlDestrutivo(t)) return t;
  return '';
}

export function classify(toolName: string, input: unknown): Verdict {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const sql = toolName === 'Bash' ? sqlDoBash(str(inp.command)) : MCP_SQL.test(toolName) ? str(inp.query) : '';
  const destrutivo = sql ? sqlDestrutivo(sql) : null;
  if (destrutivo) return { decision: 'ask', always: true, reason: `SQL destrutivo: ${destrutivo}`, sql };
  if (toolName === 'Bash') {
    const cmd = str(inp.command);
    for (const [re, reason] of BASH_SENSIVEL) if (re.test(cmd)) return { decision: 'ask', reason };
    return { decision: 'allow' };
  }
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const p = str(inp.file_path) || str(inp.notebook_path);
    for (const [re, reason] of ARQUIVO_SENSIVEL) if (re.test(p)) return { decision: 'ask', reason };
    return { decision: 'allow' };
  }
  if (toolName.startsWith('mcp__')) {
    // Root pede o cartão em qualquer modo: o orion-root só executa com uma aprovação humana registrada.
    if (toolName.startsWith('mcp__orion-root__')) return { decision: 'ask', reason: 'executar como root', always: true };
    if (MCP_NOME_BANCO.test(toolName)) return { decision: 'ask', reason: BANCO };
    if (MCP_NOME_PUBLICAR.test(toolName)) return { decision: 'ask', reason: PUBLICAR };
    const acao = str(inp.action) || str(inp.method) || str(inp.operation);
    const nome = toolName.split('__').pop() ?? '';
    if (/delete|remove|drop|destroy|trash|purge/i.test(nome) || DESTRUTIVO.test(acao)) return { decision: 'ask', reason: APAGAR };
    if (toolName === 'mcp__coolify__database') return { decision: 'ask', reason: BANCO };
    return { decision: 'allow' };
  }
  return { decision: 'allow' };
}

/** Ferramentas cuja "permissão" é na verdade uma interação com a pessoa (pergunta, sair do plano): o hook nunca decide por elas. */
const INTERATIVAS = new Set(['AskUserQuestion', 'ExitPlanMode']);

async function textoBackup(backup: BackupFn | undefined, sql: string): Promise<string> {
  if (!backup) return 'sem backup automático (projeto sem db_url)';
  let timer: NodeJS.Timeout | undefined;
  try {
    const limite = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('passou de 5 minutos')), BACKUP_TIMEOUT_MS); });
    return await Promise.race([backup(sql), limite]);
  } catch (e) {
    return `backup falhou: ${e instanceof Error ? e.message : String(e)}`;
  } finally { clearTimeout(timer); }
}

/** `rootLiberado`: a sessão tem um "liberar root" humano dentro do prazo (store.rootLiberado). */
/** `publicar`: sessão numa worktree; publicação só depois de juntar na raiz e só rodando da raiz, em qualquer modo. */
export function makePolicyHook(backup?: BackupFn, rootLiberado?: () => Promise<boolean>, publicar?: PublicarDaRaiz): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    if (i.hook_event_name !== 'PreToolUse' || i.permission_mode === 'plan' || INTERATIVAS.has(i.tool_name)) return {};
    if (i.tool_name === 'mcp__orion-root__exec') {
      const perigo = rootPerigo(str((i.tool_input as Record<string, unknown> | undefined)?.command));
      if (!perigo && rootLiberado && await rootLiberado()) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Ação sensível: executar como root${perigo ? ` (${perigo})` : ''}` } };
    }
    const inp = (i.tool_input ?? {}) as Record<string, unknown>;
    const cmd = i.tool_name === 'Bash' ? str(inp.command) : '';
    // Publicar do Orion (pedido.json) constrói a main da raiz: basta juntar a worktree antes.
    const pedidoOrion = /\/srv\/builds\/pedido\.json/.test(cmd) || str(inp.file_path) === '/srv/builds/pedido.json';
    if (publicar && (pedidoOrion || (cmd && ehPublicacao(cmd)))) {
      const negar = (motivo: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: motivo } });
      const motivo = await publicar.juntar();
      if (motivo) return negar(`Publicação recusada, nada foi publicado: ${motivo}.`);
      if (!pedidoOrion && !saiDaRaiz(cmd, publicar.raiz)) return negar(`Publicação só sai da raiz do projeto, nunca da worktree. Sua mudança já foi juntada na raiz. Rode de novo exatamente assim: cd ${publicar.raiz} && ${cmd.trim()}`);
    }
    const v = classify(i.tool_name, i.tool_input);
    if (v.always) {
      const bk = v.sql ? `. ${await textoBackup(backup, v.sql)}` : '';
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Ação sensível: ${v.reason}${bk}` } };
    }
    if (i.permission_mode === 'auto') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, ...(v.reason ? { permissionDecisionReason: `Ação sensível: ${v.reason}` } : {}) } };
  };
}

export const policyHook: HookCallback = makePolicyHook();
