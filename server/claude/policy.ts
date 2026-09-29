import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Política padrão de permissão de TODA sessão do Orion (decisão do Danilo, 29/09/2026):
 * ação comum roda sem perguntar; ação sensível vira o cartão Aprovar/Recusar no chat (o mesmo do
 * `canUseTool` do runner), nunca um bloqueio, e nunca depende do modo da sessão.
 *
 * Entra como hook PreToolUse in-process (runner.ts), que o CLI consulta ANTES do modo e do
 * classificador do modo `auto`: 'allow' pula tudo, 'ask' cai no canUseTool (o botão).
 * Opção A: o que não está na lista de sensíveis roda direto. Falso positivo custa um clique;
 * falso negativo roda sem perguntar, então na dúvida o padrão entra na lista.
 *
 * Guarda-corpo contra engano, não contra um agente malicioso: tudo roda como `danilo`, então um
 * comando ofuscado de propósito passa (risco aceito em DECISOES.md, "sem isolamento").
 */

export type Verdict = { decision: 'allow' | 'ask'; reason?: string };

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
const MCP_NOME_BANCO = /^mcp__supabase__(execute_sql|apply_migration|reset_branch|merge_branch|delete_branch|rebase_branch)$/;
const MCP_NOME_PUBLICAR = /^mcp__coolify__(deploy|redeploy_project|restart_project_apps|stop_all_apps|bulk_env_update|control)$/;
const DESTRUTIVO = /delete|remove|drop|destroy|trash|purge|prune|stop|restart|deploy/i;

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

export function classify(toolName: string, input: unknown): Verdict {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
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
    if (toolName.startsWith('mcp__orion-root__')) return { decision: 'ask', reason: 'executar como root' };
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

export const policyHook: HookCallback = async (input) => {
  const i = input as PreToolUseHookInput;
  if (i.hook_event_name !== 'PreToolUse' || i.permission_mode === 'plan' || INTERATIVAS.has(i.tool_name)) return {};
  const v = classify(i.tool_name, i.tool_input);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, ...(v.reason ? { permissionDecisionReason: `Ação sensível: ${v.reason}` } : {}) } };
};
