/**
 * Montagem do TurnParams de um turno (plano B1, tarefa T1): tudo que o Runner precisa pra rodar um turno
 * numa sessão, lido do banco e dos settings a partir de um PedidoTurno (dados simples, sem closures).
 * Antes ficava inline em routes/claude.ts, duplicado entre startFor (mensagem nova e retomada) e o
 * POST /api/claude/sessions (sessão nova). Aqui é um caminho só. Em T2 isso passa a rodar no processo
 * do runner (orion-runner), por isso o pedido é serializável e o que precisa do runner entra por `deps`.
 */
import type { Pool } from 'pg';
import type { TurnParams, TurnPrompt } from './runner.js';
import { buildSystemAppend, REGRAS_MAX, DECISOES_MAX, type MemoriaDecisao, type MemoriaRegra } from './header.js';
import { sessoesVizinhas } from './vizinhas.js';
import { orionMemoryServer } from './memoryTool.js';
import { orionRootServer } from './rootTool.js';
import { orionSenhasServer } from './senhasTool.js';
import { makeLayaHook } from './layaHook.js';
import type { BackupFn } from './policy.js';
import { resolveUltracode, withUltracodeAppend } from './ultracode.js';
import { composicaoPara } from '../tools/skillPrefs.js';
import { KEYS, getSetting, sdkEnv } from '../settings.js';
import { backupAntes, dbUrlKey } from '../dbBackup.js';
import type { FilaIntegracao } from '../integracao/fila.js';
import { ganchosDaSessao } from '../integracao/turno.js';
import { orionPublicarServer } from '../integracao/publicarTool.js';
import { enviarAvisoWhatsapp } from '../tools/avisoWhatsapp.js';
import { branchAtual } from '../tasks/git.js';
import { githubMcpServers, githubParaHeader, listarContasGithub, type GithubAccount } from '../tools/githubAccounts.js';
import { contaGithubDoProjeto, desarquivar, disallowConectores, donoDoRemote, envConectores, envLeve, listarConectoresClaudeAi, metaLeveza, remoteOrigin, type MetaLeveza } from '../tools/leveza.js';
import { WA_TOKEN_ORION, evolutionConfig, evolutionParaHeader, whatsappParaHeader } from '../tools/evolution.js';
import { cloudflareParaHeader, listarContasCloudflare } from '../tools/cloudflareAccounts.js';
import { googleCloudParaHeader, listarContasGoogleCloud } from '../tools/googleCloudAccounts.js';
import { conectoresHttpParaHeader, listarConectoresHttp } from '../tools/conectoresHttp.js';
import { cofreCdpUrl, cofreMcpServers, cofrePainelUrl, cofreParaHeader } from '../tools/cofre.js';

export type ModoPermissao = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** O que o painel manda pra abrir um turno. Só dados: cruza processo em T2. */
export type PedidoTurno = {
  sessionId: string;
  /** Quem mandou o turno: autor do que for salvo; skills e memórias do header são dele. */
  userId: number;
  prompt: TurnPrompt;
  mode: ModoPermissao;
  model?: string;
  /** Valor de fio (pode ser 'ultracode'); resolveUltracode traduz pro SDK aqui. */
  effort?: string;
  isNew: boolean;
  /** Sessão nova que nasceu na raiz sem worktree própria: o chamador registra o aviso no runner. */
  avisoPasta?: string | null;
};

export type DepsMontagem = {
  /** Nota do Orion na conversa (runner.aviso da sessão), usada pelos ganchos de integração. */
  registrar: (texto: string) => void;
  log?: (m: string) => void;
};

type SessionRow = { id: string; cwd: string; project_id: number | null; user_id: number; project_name: string | null; rules: string | null; creator: string; output_style: string | null };

/** Colunas da sessão que a montagem precisa (creator = quem criou a sessão; é o escopo padrão da orion-memory). */
export const SELECT_SESSAO = `SELECT s.id, s.cwd, s.output_style, s.project_id, s.user_id, p.name AS project_name, p.rules, u.name AS creator
       FROM claude_sessions s LEFT JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.user_id WHERE s.id = $1`;

/** Projeto para a integração; a base é a branch em que a raiz está (o que o preview raiz mostra), não `main` fixo. */
export async function projetoIntegracao(pool: Pool, projectId: number | null): Promise<{ id: number; path: string; default_branch: string } | null> {
  if (!projectId) return null;
  const { rows } = await pool.query('SELECT id, path FROM projects WHERE id = $1', [projectId]);
  if (!rows[0]) return null;
  return { id: rows[0].id, path: rows[0].path, default_branch: (await branchAtual(rows[0].path)) ?? 'main' };
}

/** Backup antes de SQL destrutivo (policy.ts): só existe quando o projeto tem db_url configurado. */
async function backupPara(pool: Pool, projectId: number | null): Promise<BackupFn | undefined> {
  if (!projectId) return undefined;
  const dbUrl = await getSetting(pool, dbUrlKey(projectId));
  const { rows } = await pool.query('SELECT slug FROM projects WHERE id = $1', [projectId]);
  const slug: string | undefined = rows[0]?.slug;
  if (!dbUrl || !slug) return undefined;
  return (sql) => backupAntes({ dbUrl, slug, sql });
}

// Leveza por projeto (12/11/2026, ver tools/leveza.ts): UMA conta GitHub por sessão (projects.meta.github_conta:
// id | 'auto' | 'nenhuma'; auto = login igual ao dono do remote origin) e conectores claude.ai só os liberados em
// projects.meta.conectores (vazio = ENABLE_CLAUDEAI_MCP_SERVERS=false). Sessão sem projeto não sobe nada disso.
async function metaDoProjeto(pool: Pool, projectId: number | null): Promise<{ leve: MetaLeveza; path: string | null }> {
  if (!projectId) return { leve: metaLeveza(null), path: null };
  const { rows } = await pool.query('SELECT path, meta FROM projects WHERE id = $1', [projectId]);
  return { leve: metaLeveza(rows[0]?.meta), path: (rows[0]?.path as string | undefined) ?? null };
}

async function contasGithubPara(pool: Pool, meta: { leve: MetaLeveza; path: string | null }): Promise<GithubAccount[]> {
  const conta = contaGithubDoProjeto(await listarContasGithub(pool), meta.leve.github_conta, donoDoRemote(meta.path ? await remoteOrigin(meta.path) : null));
  return conta ? [conta] : [];
}

async function composicaoLeve(pool: Pool, userId: number, permitidos: string[]) {
  const base = await composicaoPara(pool, userId);
  const extra = permitidos.length ? disallowConectores(await listarConectoresClaudeAi(pool), permitidos) : [];
  const disallowedTools = [...(base.disallowedTools ?? []), ...extra];
  return { ...base, ...(disallowedTools.length ? { disallowedTools } : {}) };
}

// Memórias que entram no systemAppend, por nível (0/1 chegam pelo CLAUDE.md; 4 só pela tool):
// nível 2 com corpo (universais + do projeto da sessão + do usuário criador), nível 3 só índice.
async function memoriasPara(pool: Pool, projectId: number | null, userId: number, log: (m: string) => void): Promise<{ regras: MemoriaRegra[]; decisoes: MemoriaDecisao[] }> {
  try {
    // Só memória ativa (substituída sai do prompt). Teto por relevância = as mais recentes primeiro;
    // o que passar do teto continua acessível pelo buscar da tool, e o corte vai para o log.
    const { rows } = await pool.query(
      `SELECT level, code, title, summary, body_md, scope_project_id, scope_user_id FROM memories
        WHERE level IN (2, 3) AND estado = 'ativa' AND (scope_project_id = $1 OR scope_user_id = $2 OR (scope_project_id IS NULL AND scope_user_id IS NULL))
        ORDER BY level ASC, (scope_project_id IS NOT NULL) DESC, (scope_user_id IS NOT NULL) DESC, updated_at DESC`, [projectId, userId]);
    const escopo = (r: any) => (r.scope_project_id ? 'projeto' : r.scope_user_id ? 'usuário' : 'universal') as MemoriaRegra['scope'];
    const regras = rows.filter((r: any) => r.level === 2);
    const decisoes = rows.filter((r: any) => r.level === 3);
    if (regras.length > REGRAS_MAX || decisoes.length > DECISOES_MAX) {
      log(`memória: prompt cortou ${Math.max(0, regras.length - REGRAS_MAX)} regra(s) e ${Math.max(0, decisoes.length - DECISOES_MAX)} decisão(ões) (projeto ${projectId ?? 'neutro'}, usuário ${userId})`);
    }
    return {
      regras: regras.slice(0, REGRAS_MAX)
        .map((r: any) => ({ title: r.title, body: r.body_md, scope: escopo(r) })),
      decisoes: decisoes.slice(0, DECISOES_MAX)
        .map((r: any) => ({ code: r.code, title: r.title, summary: r.summary })),
    };
  } catch { return { regras: [], decisoes: [] }; }
}

/**
 * Monta o TurnParams de um turno a partir da linha da sessão: env, MCPs (github da conta do projeto, cofre,
 * orion-memory, orion-root, orion-senhas pro owner, orion-publicar na worktree), ganchos de integração, Laya,
 * backup antes de SQL destrutivo, composição de skills e o systemAppend (header + memórias + conectores + vizinhas).
 * Lança se a sessão não existe.
 */
export async function montarTurno(pool: Pool, fila: FilaIntegracao, o: PedidoTurno, deps: DepsMontagem): Promise<TurnParams> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const { rows } = await pool.query<SessionRow>(SELECT_SESSAO, [o.sessionId]);
  const s = rows[0];
  if (!s) throw new Error(`sessão ${o.sessionId} não existe`);
  const projectId = s.project_id ?? null;
  // `effort` chega no valor de fio (pode ser 'ultracode', vindo da rota ou da coluna persistida):
  // resolveUltracode traduz pro SDK e liga a instrução de orquestração no systemAppend quando for o caso.
  const eff = resolveUltracode(o.effort);
  if (!o.isNew) await desarquivar(pool, s.id).catch(() => 0); // retomada de sessão arquivada: o seq continua de onde parou
  const textoPrompt = typeof o.prompt === 'string' ? o.prompt : o.prompt.text;
  const ganchos = ganchosDaSessao({
    cwd: s.cwd, projeto: await projetoIntegracao(pool, projectId), prompt: textoPrompt.replace(/^\[[^\]]+\]\s*/, ''), fila,
    pessoa: /^\[([^\]]+)\]/.exec(textoPrompt)?.[1] ?? s.creator,
    registrar: deps.registrar,
    avisar: (texto) => enviarAvisoWhatsapp(pool, texto),
  });
  const meta = await metaDoProjeto(pool, projectId);
  const contas = await contasGithubPara(pool, meta);
  // orion-senhas: cofre PESSOAL do Danilo (Vaultwarden), só entra quando quem mandou o turno é owner.
  const { rows: autorRows } = await pool.query('SELECT role FROM users WHERE id = $1', [o.userId]);
  return {
    sessionId: s.id, cwd: s.cwd, prompt: o.prompt, isNew: o.isNew, ganchos, permissionMode: o.mode, model: o.model, effort: eff.effort,
    outputStyle: s.output_style ?? undefined,
    layaHook: makeLayaHook(pool, s.id, { modelo: o.model, esforco: eff.effort }),
    env: envLeve(envConectores(sdkEnv(await getSetting(pool, KEYS.claudeToken)), meta.leve.conectores)),
    // MCPs de toda sessão: github da conta do projeto + orion-memory (sempre) + orion-root (sempre).
    // Cloudflare, Hostinger, Coolify, n8n e Supabase não são MCP: são conectores simples (proxy local /conector/<nome>), só entram no header.
    // A orion-memory recebe o contexto da SESSÃO (projeto + criador, s.user_id): é ele que vira o escopo padrão do salvar.
    mcpServers: {
      ...githubMcpServers(contas),
      // Cofre (navegador compartilhado, 32 tools): só em projeto que ligou (projects.meta.cofre, ver tools/leveza.ts).
      ...(meta.leve.cofre ? (cofreMcpServers(cofreCdpUrl()) ?? {}) : {}),
      'orion-memory': orionMemoryServer(pool, { sessionId: s.id, projectId, userId: s.user_id, autorId: o.userId }),
      'orion-root': orionRootServer(s.id),
      ...(autorRows[0]?.role === 'owner' ? { 'orion-senhas': orionSenhasServer() } : {}),
      ...(ganchos ? { 'orion-publicar': orionPublicarServer(ganchos.publicador) } : {}),
    },
    ...(await composicaoLeve(pool, o.userId, meta.leve.conectores)),
    taskBudgetTokens: Number(await getSetting(pool, KEYS.taskBudgetTokens)) || undefined,
    backupSql: await backupPara(pool, projectId),
    systemAppend: withUltracodeAppend(buildSystemAppend({
      projectName: s.project_name ?? null, projectPath: s.cwd, createdBy: s.creator, rules: s.rules,
      ...(await memoriasPara(pool, projectId, o.userId, log)),
      github: githubParaHeader(contas),
      cloudflare: cloudflareParaHeader(await listarContasCloudflare(pool)),
      googleCloud: googleCloudParaHeader(await listarContasGoogleCloud(pool)),
      evolution: evolutionParaHeader(await evolutionConfig(pool)),
      whatsapp: whatsappParaHeader(await getSetting(pool, WA_TOKEN_ORION)),
      conectores: conectoresHttpParaHeader(await listarConectoresHttp(pool)),
      cofre: meta.leve.cofre ? cofreParaHeader(cofreCdpUrl(), cofrePainelUrl()) : null,
      vizinhas: await sessoesVizinhas(pool, projectId, s.id, o.userId),
    }), eff.ultracode),
  };
}
