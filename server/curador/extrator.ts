/**
 * EXTRATOR diário da memória (entrega 2 de docs/plans/2026-10-01-memoria-v3.md): a gravação que
 * não depende de o modelo da sessão lembrar. Roda no mesmo timer do curador (orion-curador),
 * antes dele. Lê os turnos do dia do histórico (server/memories/historico.ts: quem, quando, pedido
 * e resposta, sem ruído de tool), um projeto por vez, e pede a um modelo barato que registre com a
 * tool `fato` só o que é durável. Substitui o papel do claude-mem com UMA chamada por projeto por
 * dia em vez de uma por tool call.
 *
 * Freios contra inchaço (revisão de 01/10): no máximo MAX_FATOS_POR_PROJETO por rodada; nasce com
 * NOTA_EXTRATOR (3, não 5), então fato que ninguém busca morre em 60 dias pelo decaimento que já
 * existe; corpo curto; duplicata (cosseno >= 0,95 no escopo) é recusada pelo próprio salvar.
 * Decisão detectada (decisao: true) vira proposta de promoção para o Danilo aprovar no painel.
 *
 * Lógica em funções com query injetada; o SDK só entra em extrairDoDia (tests/extrator.test.ts).
 */
import { z } from 'zod';
import { createSdkMcpServer, query as sdkQuery, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import { salvarMemoria, type MemQuery } from '../claude/memoryTool.js';
import { criarProposta } from './proposals.js';
import { ensureHistoricoTable, materializarTurnos } from '../memories/historico.js';

export const MAX_FATOS_POR_PROJETO = 5;
export const NOTA_EXTRATOR = 3;
export const TRANSCRICAO_MAX = 60_000;
export const MODELO_EXTRATOR = process.env.EXTRATOR_MODEL ?? 'claude-haiku-4-5-20251001';

export const EXTRATOR_PROMPT = [
  'Você é o extrator de memória do painel Orion. Vai receber a transcrição dos turnos do dia de UM projeto: quem falou, quando, o que pediu e o que o assistente respondeu.',
  'Registre com a tool fato só o que é durável e não é óbvio pelo código: decisão tomada por uma pessoa, regra ou preferência dita, fato de infraestrutura ou de negócio, pendência combinada entre pessoas.',
  `No máximo ${MAX_FATOS_POR_PROJETO} fatos, os mais importantes. Título curto. Corpo de 1 a 3 linhas começando por quem e quando (ex.: "Guilherme, 01/10: ..."). autor_nome é a pessoa que falou.`,
  'decisao: true só quando alguém fechou uma decisão de forma explícita ("decidido", "fechado", "a partir de agora").',
  'Não registre segredos (token, senha, chave), passos de depuração, nem o que já está no código ou na memória (a tool recusa duplicata; não insista).',
  'Se não houver nada durável, não chame a tool e responda só "nada".',
].join('\n');

export type ExtratorStats = {
  projetos: number; turnos: number; fatos: number; duplicadas: number; propostas: number;
  tokens: { entrada: number; saida: number };
};

export function novasStats(): ExtratorStats {
  return { projetos: 0, turnos: 0, fatos: 0, duplicadas: 0, propostas: 0, tokens: { entrada: 0, saida: 0 } };
}

type Turno = { ts: Date | string; autor_nome: string | null; prompt: string; resposta: string };

function hora(ts: Date | string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Transcrição compacta e cronológica; passou do teto, fica o FIM (o mais recente). */
export function montarTranscricao(turnos: Turno[], max = TRANSCRICAO_MAX): string {
  const linhas = turnos.map((t) =>
    `[${hora(t.ts)}] ${t.autor_nome ?? 'alguém'}: ${(t.prompt ?? '').trim().slice(0, 800)}\n-> ${(t.resposta ?? '').trim().slice(0, 1200)}`);
  const texto = linhas.join('\n\n');
  return texto.length > max ? texto.slice(-max) : texto;
}

export type FatoArgs = { titulo: string; corpo: string; resumo?: string | null; keywords?: string[] | null; autor_nome?: string | null; decisao?: boolean | null };
export type FatoResultado = { registrado: true; code: string; proposta?: number } | { registrado: false; motivo: string; parecida?: string };

/** Lógica da tool `fato`: limite por projeto, autor pelo nome, salvar com dedupe, proposta de promoção se for decisão. */
export async function registrarFato(
  q: MemQuery,
  ctx: { projetoId: number; ownerId: number; fatosNestaRodada: { n: number } },
  args: FatoArgs,
  stats: ExtratorStats,
): Promise<FatoResultado> {
  if (ctx.fatosNestaRodada.n >= MAX_FATOS_POR_PROJETO) {
    return { registrado: false, motivo: `limite de ${MAX_FATOS_POR_PROJETO} fatos por projeto por rodada; pare` };
  }
  let autorId: number | null = null;
  if (args.autor_nome?.trim()) {
    const { rows } = await q('SELECT id FROM users WHERE lower(name) = lower($1) LIMIT 1', [args.autor_nome.trim()]);
    autorId = rows[0]?.id ?? null;
  }
  const r = await salvarMemoria(
    q,
    { sessionId: 'extrator', projectId: ctx.projetoId, userId: autorId ?? ctx.ownerId, autorId: autorId ?? undefined },
    { titulo: args.titulo, corpo: args.corpo, nivel: 4, resumo: args.resumo ?? undefined, keywords: args.keywords ?? undefined, escopo: 'projeto' },
    undefined,
    { origem: 'extrator', nota: NOTA_EXTRATOR },
  );
  if (!r.salva) {
    stats.duplicadas++;
    return { registrado: false, motivo: 'já existe memória quase igual; não repita', parecida: r.parecida };
  }
  ctx.fatosNestaRodada.n++;
  stats.fatos++;
  if (args.decisao) {
    const { rows } = await q('SELECT id FROM memories WHERE code = $1', [r.code]);
    if (rows[0]) {
      try {
        const p = await criarProposta(q, { tipo: 'promocao', memoria_ids: [rows[0].id], justificativa: `extrator: decisão fechada em conversa${args.autor_nome ? ` por ${args.autor_nome}` : ''}; promover a nível 3 se o Danilo confirmar` });
        stats.propostas++;
        return { registrado: true, code: r.code, proposta: p.id };
      } catch { /* promoção é bônus; o fato já está salvo */ }
    }
  }
  return { registrado: true, code: r.code };
}

function texto(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export function extratorServer(q: MemQuery, ctx: { projetoId: number; ownerId: number; fatosNestaRodada: { n: number } }, stats: ExtratorStats): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'extrator',
    version: '1.0.0',
    instructions: 'Registre com fato só o que é durável; no máximo 5 por projeto; duplicata é recusada.',
    tools: [
      tool(
        'fato',
        'Registra um fato durável do dia como micro-fato (nível 4) no projeto, com autor e data. Decisão fechada vira proposta de promoção.',
        {
          titulo: z.string().describe('Título curto'),
          corpo: z.string().describe('1 a 3 linhas, começando por quem e quando'),
          resumo: z.string().optional().describe('Até 500 caracteres'),
          keywords: z.array(z.string()).optional().describe('Até 4'),
          autor_nome: z.string().optional().describe('Nome de quem falou (como aparece na transcrição)'),
          decisao: z.boolean().optional().describe('true só para decisão fechada explicitamente'),
        },
        async (a) => {
          try { return texto(await registrarFato(q, ctx, a, stats)); }
          catch (e) { return { content: [{ type: 'text' as const, text: `erro: ${(e as Error)?.message ?? e}` }], isError: true }; }
        },
      ),
    ],
  });
}

const JANELA = `h.extraido_at IS NULL AND h.ts >= now() - interval '2 days'`;

/** Roda o extrator para todos os projetos com turnos novos nas últimas 48 h. */
export async function extrairDoDia(pool: Pool, opts: { env?: Record<string, string>; log?: (m: string) => void; model?: string } = {}): Promise<ExtratorStats> {
  const log = opts.log ?? console.log;
  const q: MemQuery = (sql, params) => pool.query(sql, params as any[]);
  const stats = novasStats();
  await ensureHistoricoTable(pool);
  const novos = await materializarTurnos(q);
  if (novos) log(`extrator: ${novos} turno(s) materializado(s) no histórico`);

  const { rows: [owner] } = await q(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
  const ownerId: number = owner?.id ?? 1;
  const { rows: grupos } = await q(
    `SELECT p.id, p.slug, count(*)::int AS n FROM historico_turnos h JOIN projects p ON p.id = h.projeto_id
      WHERE ${JANELA} GROUP BY p.id, p.slug ORDER BY p.id`,
  );
  for (const g of grupos) {
    const { rows: turnos } = await q(
      `SELECT h.ts, h.autor_nome, h.prompt, h.resposta FROM historico_turnos h WHERE h.projeto_id = $1 AND ${JANELA} ORDER BY h.ts`,
      [g.id],
    );
    if (!turnos.length) continue;
    stats.projetos++; stats.turnos += turnos.length;
    const ctx = { projetoId: g.id as number, ownerId, fatosNestaRodada: { n: 0 } };
    let ok = false;
    try {
      const run = sdkQuery({
        prompt: `Projeto ${g.slug}. Transcrição dos turnos (${turnos.length}):\n\n${montarTranscricao(turnos)}`,
        options: {
          cwd: process.env.ORION_REPO ?? '/srv/orion',
          systemPrompt: EXTRATOR_PROMPT,
          model: opts.model ?? MODELO_EXTRATOR,
          maxTurns: MAX_FATOS_POR_PROJETO + 4,
          permissionMode: 'default',
          disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
          canUseTool: async (toolName) =>
            toolName.startsWith('mcp__extrator__') ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: 'o extrator só usa a tool fato' },
          mcpServers: { extrator: extratorServer(q, ctx, stats) },
          ...(opts.env ? { env: opts.env } : {}),
        },
      });
      for await (const m of run) {
        if (m.type === 'result') {
          const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          stats.tokens.entrada += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
          stats.tokens.saida += u?.output_tokens ?? 0;
          ok = !m.is_error;
          log(`extrator ${g.slug}: ${m.subtype === 'success' ? String((m as { result?: string }).result ?? '').slice(0, 200) : m.subtype}`);
        }
      }
    } catch (e) {
      log(`extrator ${g.slug}: falhou (${(e as Error)?.message ?? e}); tenta de novo na próxima rodada`);
    }
    // Só marca como extraído quando a rodada terminou bem; erro deixa os turnos para amanhã.
    if (ok) await q(`UPDATE historico_turnos h SET extraido_at = now() WHERE h.projeto_id = $1 AND ${JANELA}`, [g.id]);
  }
  return stats;
}
