/**
 * Leveza por sessão (12/11/2026). Medido na c3 antes disto: cada sessão subia com 1013 ferramentas,
 * 147 servidores MCP (118 "failed"/"needs-auth"), 719 comandos de barra e 57 plugins — 5,6 s só até o
 * `init` e ~70k tokens de prefixo. Três fontes: plugins/skills sincronizados da conta claude.ai
 * (desligados em ~/.claude/settings.json: syncClaudeAiPlugins/syncClaudeAiSkills=false), conectores
 * claude.ai (Magnific 269 tools, higgsfield 169, Meta ADS 102…; aqui: só os liberados pelo projeto) e
 * uma cópia do MCP do GitHub por conta cadastrada (aqui: só a conta do projeto, via proxy local).
 * Funções puras no topo (tests/leveza.test.ts); disco/banco embaixo.
 */
import { execFile } from 'node:child_process';
import type { Pool } from 'pg';

/** "claude.ai Magnific (2)" → "claude_ai_Magnific_2": é assim que o CLI nomeia as tools (mcp__<slug>__<tool>). */
export function slugMcpClaudeAi(nome: string): string {
  return nome.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** disallowedTools pra esconder os conectores claude.ai que o projeto NÃO liberou (`mcp__<server>` cobre todas as tools dele). */
export function disallowConectores(todos: string[], permitidos: string[]): string[] {
  const ok = new Set(permitidos.map(slugMcpClaudeAi));
  return [...new Set(todos.map(slugMcpClaudeAi))].filter(s => s && !ok.has(s)).map(s => `mcp__${s}`);
}

/** Env da sessão: os conectores claude.ai só sobem quando o projeto liberou pelo menos um. */
export function envConectores(env: Record<string, string> | undefined, permitidos: string[]): Record<string, string> {
  const base = env ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return { ...base, ENABLE_CLAUDEAI_MCP_SERVERS: permitidos.length ? 'true' : 'false' };
}

/** Dono (owner) de um remote do GitHub, https ou ssh; null se não for GitHub. */
export function donoDoRemote(url: string | null | undefined): string | null {
  const m = url ? /github\.com[/:]([^/\s]+)(?:\/|$)/i.exec(url.trim()) : null;
  return m ? m[1].toLowerCase() : null;
}

export type GithubEscolha = number | 'auto' | 'nenhuma' | undefined;
export type MetaLeveza = { conectores: string[]; github_conta: GithubEscolha };

/** Lê o que importa do `projects.meta` sem confiar na forma. */
export function metaLeveza(meta: unknown): MetaLeveza {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  const conectores = Array.isArray(m.conectores) ? m.conectores.filter((x): x is string => typeof x === 'string') : [];
  const g = m.github_conta;
  return { conectores, github_conta: g === 'nenhuma' || g === 'auto' ? g : typeof g === 'number' ? g : undefined };
}

/** Conta GitHub da sessão: id escolhido no projeto, 'nenhuma', ou (auto) a conta cujo login é o dono do remote origin. */
export function contaGithubDoProjeto<T extends { id: number; login: string }>(contas: T[], escolha: GithubEscolha, dono: string | null): T | null {
  if (escolha === 'nenhuma') return null;
  if (typeof escolha === 'number') return contas.find(c => c.id === escolha) ?? null;
  return dono ? contas.find(c => c.login.toLowerCase() === dono.toLowerCase()) ?? null : null;
}

export const TOOL_RESULT_MAX = 20_000;

/**
 * Corta tool_result acima de TOOL_RESULT_MAX na PERSISTÊNCIA (a sessão viu tudo; só o histórico encolhe).
 * Achado de 12/11/2026: tool_results eram 938 MB dos 1,5 GB de claude_events, e cada abertura de sessão
 * carregava isso. Nunca mexe no que não é tool_result.
 */
export function truncarToolResult<T>(payload: T, max = TOOL_RESULT_MAX): T {
  const p = payload as { type?: string; message?: { content?: unknown } } | null;
  if (!p || p.type !== 'user' || !Array.isArray(p.message?.content)) return payload;
  let mudou = false;
  const corta = (s: string) => {
    if (s.length <= max) return s;
    mudou = true;
    return `${s.slice(0, max)}\n… [cortado pelo Orion ao gravar: ${Math.round((s.length - max) / 1024)} KB a mais; a sessão viu o conteúdo inteiro]`;
  };
  const content = (p.message!.content as Array<Record<string, unknown>>).map(b => {
    if (!b || b.type !== 'tool_result') return b;
    if (typeof b.content === 'string') return { ...b, content: corta(b.content) };
    if (Array.isArray(b.content)) return { ...b, content: b.content.map((c: Record<string, unknown>) => c?.type === 'text' && typeof c.text === 'string' ? { ...c, text: corta(c.text) } : c) };
    return b;
  });
  return mudou ? ({ ...(p as object), message: { ...(p.message as object), content } } as T) : payload;
}

/** `git remote get-url origin` da pasta, ou null (sem git, sem remote, pasta sumida). 5 s de teto. */
export function remoteOrigin(path: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['-C', path, 'remote', 'get-url', 'origin'], { timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

/**
 * Nomes dos conectores claude.ai que a conta tem (fonte: o `init` mais recente que os listou; nada hardcoded).
 * Sessões com ENABLE_CLAUDEAI_MCP_SERVERS=false não os listam, por isso o EXISTS.
 */
export async function listarConectoresClaudeAi(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ nome: string }>(
    `SELECT DISTINCT m->>'name' AS nome
       FROM (SELECT payload FROM claude_events
              WHERE type = 'system' AND payload->>'subtype' = 'init'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'mcp_servers') x WHERE x->>'name' LIKE 'claude.ai %')
              ORDER BY ts DESC LIMIT 1) e, jsonb_array_elements(e.payload->'mcp_servers') m
      WHERE m->>'name' LIKE 'claude.ai %' ORDER BY 1`);
  return rows.map(r => r.nome);
}
