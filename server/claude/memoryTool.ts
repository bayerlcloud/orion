/**
 * Tool MCP in-process "orion-memory": a porta da IA para a memória do painel (níveis 2-4).
 * Ligada em TODA sessão (nova e retomada) por routes/claude.ts, via options.mcpServers do
 * Agent SDK (createSdkMcpServer/tool, mesmo canal do hostinger).
 *
 * - buscar: busca textual (to_tsvector 'portuguese' + plainto_tsquery, com fallback ILIKE) sobre
 *   título/resumo/corpo/palavras-chave. Deixa rastro de acesso e, nos micro-fatos (nível 4),
 *   sobe a nota em 1 (teto 10) no máximo uma vez por dia por memória.
 * - salvar: grava nos níveis 2-4 (nível 0 é do Danilo, nível 1 do gerador; recusa com mensagem
 *   clara). Micro-fato nasce com a nota inicial.
 *
 * A lógica de banco vive em funções que recebem uma query mínima injetada, para os testes
 * rodarem com pool mockado (tests/memoryTool.test.ts).
 */
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import { MAX_KEYWORDS, NOTA_INICIAL, truncateSummary, uniqueCode } from '../memories/util.js';

export type MemQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export type MemoryToolCtx = { sessionId: string; projectId: number | null; userId: number };

export type MemoriaEncontrada = {
  code: string;
  nivel: number;
  nota: number | null;
  titulo: string;
  resumo: string;
  corpo: string;
};

const CAMPOS_BUSCA = `coalesce(m.title,'') || ' ' || coalesce(m.summary,'') || ' ' || coalesce(m.body_md,'') || ' ' || array_to_string(m.keywords, ' ')`;

export async function buscarMemorias(
  query: MemQuery,
  ctx: MemoryToolCtx,
  args: { consulta: string; nivel?: number | null },
): Promise<MemoriaEncontrada[]> {
  const consulta = (args.consulta ?? '').trim();
  if (!consulta) throw new Error('informe a consulta');
  const nivel = args.nivel == null ? null : Number(args.nivel);
  if (nivel !== null && (!Number.isInteger(nivel) || nivel < 2 || nivel > 4)) {
    throw new Error('nivel, quando informado, vai de 2 a 4 (0 e 1 chegam pelo CLAUDE.md, não pela busca)');
  }

  // Primeiro full-text em português; se nada vier (ou a consulta não render tsquery), cai pro ILIKE.
  let { rows } = await query(
    `SELECT m.id, m.code, m.level, m.nota, m.title, m.summary, m.body_md
       FROM memories m
      WHERE m.level BETWEEN 2 AND 4 AND ($2::int IS NULL OR m.level = $2)
        AND to_tsvector('portuguese', ${CAMPOS_BUSCA}) @@ plainto_tsquery('portuguese', $1)
      ORDER BY ts_rank(to_tsvector('portuguese', ${CAMPOS_BUSCA}), plainto_tsquery('portuguese', $1)) DESC, m.level ASC
      LIMIT 8`,
    [consulta, nivel],
  );
  if (!rows.length) {
    const like = `%${consulta}%`;
    rows = (await query(
      `SELECT m.id, m.code, m.level, m.nota, m.title, m.summary, m.body_md
         FROM memories m
        WHERE m.level BETWEEN 2 AND 4 AND ($2::int IS NULL OR m.level = $2)
          AND (m.title ILIKE $1 OR m.summary ILIKE $1 OR m.body_md ILIKE $1
               OR EXISTS (SELECT 1 FROM unnest(m.keywords) k WHERE k ILIKE $1))
        ORDER BY m.level ASC, m.updated_at DESC
        LIMIT 8`,
      [like, nivel],
    )).rows;
  }
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  // Micro-fato buscado fica mais vivo: nota + 1 (teto 10), no máximo uma vez por dia por memória.
  // Roda ANTES do rastro de acesso, porque a elegibilidade olha o last_accessed_at anterior.
  const bump = await query(
    `UPDATE memories SET nota = LEAST(nota + 1, 10)
      WHERE id = ANY($1) AND level = 4
        AND (last_accessed_at IS NULL OR last_accessed_at::date <> current_date)
      RETURNING id, nota`,
    [ids],
  );
  const notaNova = new Map<number, number>(bump.rows.map((r) => [r.id, r.nota]));
  await query(
    `UPDATE memories SET last_accessed_at = now(), last_accessed_session = $2, last_accessed_reason = $3
      WHERE id = ANY($1)`,
    [ids, ctx.sessionId, `busca pela tool orion-memory: "${consulta.slice(0, 120)}"`],
  );

  return rows.map((r) => ({
    code: r.code,
    nivel: r.level,
    nota: notaNova.get(r.id) ?? r.nota,
    titulo: r.title,
    resumo: r.summary,
    corpo: r.body_md,
  }));
}

export async function salvarMemoria(
  query: MemQuery,
  ctx: MemoryToolCtx,
  args: {
    titulo: string;
    corpo: string;
    nivel?: number | null;
    resumo?: string | null;
    keywords?: string[] | null;
    escopo_projeto_id?: number | null;
    escopo_usuario_id?: number | null;
  },
): Promise<{ code: string; nivel: number; nota: number | null }> {
  const titulo = (args.titulo ?? '').trim();
  if (!titulo) throw new Error('informe o título');
  const nivel = args.nivel == null ? 4 : Number(args.nivel);
  if (nivel === 0 || nivel === 1) {
    throw new Error(
      'nível 0 (constituição) é só do Danilo e nível 1 (mapas) é só do gerador automático; a IA escreve nos níveis 2 (regra), 3 (decisão) e 4 (micro-fato)',
    );
  }
  if (![2, 3, 4].includes(nivel)) throw new Error('nivel vai de 2 a 4');
  const nota = nivel === 4 ? NOTA_INICIAL : null;
  const resumo = truncateSummary(args.resumo ?? '');
  const keywords = [...new Set((args.keywords ?? []).map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  const escopoProjeto = args.escopo_projeto_id == null ? null : Number(args.escopo_projeto_id);
  const escopoUsuario = args.escopo_usuario_id == null ? null : Number(args.escopo_usuario_id);

  const code = await uniqueCode((sql, params) => query(sql, params), titulo);
  await query(
    `INSERT INTO memories (code, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`,
    [code, titulo, resumo, args.corpo ?? '', nivel, nota, keywords, escopoProjeto, escopoUsuario],
  );
  return { code, nivel, nota };
}

function texto(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function erro(e: unknown) {
  return { content: [{ type: 'text' as const, text: `erro: ${(e as Error)?.message ?? e}` }], isError: true };
}

/** Servidor MCP in-process por sessão (o sessionId entra no rastro de acesso de cada busca). */
export function orionMemoryServer(pool: Pool, ctx: MemoryToolCtx): McpSdkServerConfigWithInstance {
  const query: MemQuery = (sql, params) => pool.query(sql, params as any[]);
  return createSdkMcpServer({
    name: 'orion-memory',
    version: '1.0.0',
    instructions:
      'Memória do painel Orion. Use buscar para achar regras, decisões e micro-fatos; use salvar quando aprender algo durável (regra nível 2, decisão nível 3 ou micro-fato nível 4).',
    tools: [
      tool(
        'buscar',
        'Busca memórias do painel Orion (níveis 2 a 4) por texto. Devolve código, nível, nota, título, resumo e corpo das mais relevantes (top 8). Use para ler o corpo de uma decisão nível 3 do índice ou para achar micro-fatos.',
        {
          consulta: z.string().describe('Palavras a buscar (título, resumo, corpo e palavras-chave)'),
          nivel: z.number().int().min(2).max(4).optional().describe('Restringe a um nível: 2 regra, 3 decisão, 4 micro-fato'),
        },
        async (a) => {
          try {
            const memorias = await buscarMemorias(query, ctx, a);
            return texto({ encontradas: memorias.length, memorias });
          } catch (e) {
            return erro(e);
          }
        },
      ),
      tool(
        'salvar',
        'Salva uma memória nova no painel Orion. Níveis permitidos: 2 (regra por projeto/usuário), 3 (decisão fechada) e 4 (micro-fato, padrão; nasce com nota 5). Nunca use para os níveis 0 e 1.',
        {
          titulo: z.string().describe('Título curto da memória'),
          corpo: z.string().describe('Corpo em markdown'),
          nivel: z.number().int().min(2).max(4).optional().describe('2 regra, 3 decisão, 4 micro-fato (padrão 4)'),
          resumo: z.string().optional().describe('Resumo de até 144 caracteres (é cortado se passar)'),
          keywords: z.array(z.string()).optional().describe('Até 4 palavras-chave'),
          escopo_projeto_id: z.number().int().optional().describe('id do projeto quando a memória vale só para ele'),
          escopo_usuario_id: z.number().int().optional().describe('id do usuário quando a memória é sobre ele'),
        },
        async (a) => {
          try {
            const r = await salvarMemoria(query, ctx, a);
            return texto({ salva: true, ...r });
          } catch (e) {
            return erro(e);
          }
        },
      ),
    ],
  });
}
