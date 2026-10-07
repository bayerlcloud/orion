/**
 * Tool MCP in-process "orion-memory": a porta da IA para a memória do painel (níveis 2-4).
 * Ligada em TODA sessão (nova e retomada) por routes/claude.ts, via options.mcpServers do
 * Agent SDK (createSdkMcpServer/tool, mesmo canal do hostinger).
 *
 * Desenho em docs/plans/2026-10-01-memoria-v3.md (entrega 1):
 * - buscar: busca híbrida. Full-text 'portuguese' com peso título (A) > resumo (B) > corpo e
 *   keywords (C) e, com a coluna memories.embedding presente, busca vetorial (cosseno, embeddings
 *   locais de server/memories/embed.ts), fusão por reciprocal rank fusion (top 8). Só memória ATIVA
 *   e do ESCOPO da sessão (universal + projeto + pessoa); todos_projetos: true cruza projetos. Sem
 *   resultado nenhum, cai pro ILIKE. Deixa rastro de acesso e, nos micro-fatos (nível 4), sobe a
 *   nota em 1 (teto 10) no máximo uma vez por dia por memória.
 * - salvar: grava nos níveis 2-4 (0 é do Danilo, 1 do gerador; recusa com mensagem clara) com
 *   autor (quem mandou o turno), sessão de origem e origem 'tool'. Escopo: projeto da sessão
 *   (padrão), plataforma (universal, vale para todos os projetos) ou pessoa (criador da sessão).
 *   Antes de inserir, procura a memória mais parecida NO MESMO ESCOPO: cosseno >= LIMIAR_DUPLICATA
 *   não grava e devolve o code (use atualizar ou forcar: true); >= LIMIAR_PARECIDA grava e avisa.
 *   Limiares calibrados em 01/10/2026 com as 73 memórias reais: duplicata de verdade fica em 0,95+,
 *   memórias distintas chegam a 0,944.
 * - atualizar: níveis 2 e 4 na hora (o corpo antigo fica em corpo_anterior, embedding recalculado);
 *   nível 3 é decisão fechada e vira proposta do curador (reescrita ou deleção), aprovada no painel.
 *   estado 'substituida' aposenta a memória: sai da busca e do índice do prompt, fica no banco.
 *
 * A lógica de banco vive em funções que recebem uma query mínima injetada (e um embedder
 * injetável), para os testes rodarem com pool e embedder mockados (tests/memoryTool.test.ts).
 */
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import { MAX_KEYWORDS, NOTA_INICIAL, truncateSummary, uniqueCode } from '../memories/util.js';
import { embedConsulta, embedCorpo, temColunaEmbedding, textoDaMemoria, vetorSql, type Embedder } from '../memories/embed.js';
import { criarProposta } from '../curador/proposals.js';
import { buscarHistorico, materializarTurnos } from '../memories/historico.js';

export type MemQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

/** userId = criador da sessão (escopo padrão); autorId = quem mandou o turno atual (autor da memória). */
export type MemoryToolCtx = { sessionId: string; projectId: number | null; userId: number; autorId?: number };

export type Escopo = 'universal' | 'projeto' | 'pessoa';

export type MemoriaEncontrada = {
  code: string;
  nivel: number;
  nota: number | null;
  titulo: string;
  resumo: string;
  corpo: string;
  escopo: Escopo;
  autor: string | null;
  quando: string | null;
};

/** Cosseno a partir do qual salvar RECUSA (duplicata) e a partir do qual só AVISA (parecida). */
export const LIMIAR_DUPLICATA = 0.95;
export const LIMIAR_PARECIDA = 0.9;

/** Full-text com peso: título pesa mais que resumo, que pesa mais que corpo e keywords. */
const TSV = `(setweight(to_tsvector('portuguese', coalesce(m.title,'')), 'A')
  || setweight(to_tsvector('portuguese', coalesce(m.summary,'')), 'B')
  || setweight(to_tsvector('portuguese', coalesce(m.body_md,'') || ' ' || array_to_string(m.keywords, ' ')), 'C'))`;

/**
 * Filtro comum das três buscas: nível 2-4 (ou um nível só), memória ativa e escopo da sessão.
 * Posições fixas: $2 nível, $3 projeto, $4 usuário, $5 todos_projetos (true desliga o escopo).
 */
const FILTRO = `m.level BETWEEN 2 AND 4 AND ($2::int IS NULL OR m.level = $2) AND m.estado = 'ativa'
  AND ($5::boolean OR (m.scope_project_id IS NULL AND m.scope_user_id IS NULL) OR m.scope_project_id = $3 OR m.scope_user_id = $4)`;

const COLUNAS = `m.id, m.code, m.level, m.nota, m.title, m.summary, m.body_md, m.scope_project_id, m.scope_user_id, m.created_at, u.name AS autor`;
const DE = `FROM memories m LEFT JOIN users u ON u.id = m.autor_user_id`;

function escopoDe(r: { scope_project_id?: number | null; scope_user_id?: number | null }): Escopo {
  return r.scope_project_id ? 'projeto' : r.scope_user_id ? 'pessoa' : 'universal';
}

function quandoDe(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && v ? v.slice(0, 10) : null;
}

/**
 * Reciprocal rank fusion (k = 60): cada lista contribui 1/(k + posição) por memória; ordena
 * pela soma e devolve o top 8. Memória que aparece nas duas listas sobe.
 */
function fundirPorRrf(...listas: Array<any[]>): any[] {
  const porId = new Map<unknown, { row: any; score: number }>();
  for (const lista of listas) {
    lista.forEach((row, i) => {
      const atual = porId.get(row.id) ?? { row, score: 0 };
      atual.score += 1 / (60 + i + 1);
      porId.set(row.id, atual);
    });
  }
  return [...porId.values()].sort((a, b) => b.score - a.score).map((x) => x.row).slice(0, 8);
}

export async function buscarMemorias(
  query: MemQuery,
  ctx: MemoryToolCtx,
  args: { consulta: string; nivel?: number | null; todos_projetos?: boolean | null },
  embedder: Embedder = embedConsulta,
): Promise<MemoriaEncontrada[]> {
  const consulta = (args.consulta ?? '').trim();
  if (!consulta) throw new Error('informe a consulta');
  const nivel = args.nivel == null ? null : Number(args.nivel);
  if (nivel !== null && (!Number.isInteger(nivel) || nivel < 2 || nivel > 4)) {
    throw new Error('nivel, quando informado, vai de 2 a 4 (0 e 1 chegam pelo CLAUDE.md, não pela busca)');
  }
  const escopo = [nivel, ctx.projectId, ctx.userId, !!args.todos_projetos];

  // Primeiro full-text em português; com a migração pgvector aplicada, também a busca vetorial
  // (cosseno) e a fusão dos dois rankings. Se nada vier, cai pro ILIKE.
  let { rows } = await query(
    `SELECT ${COLUNAS} ${DE}
      WHERE ${FILTRO} AND ${TSV} @@ plainto_tsquery('portuguese', $1)
      ORDER BY ts_rank(${TSV}, plainto_tsquery('portuguese', $1)) DESC, m.level ASC
      LIMIT 8`,
    [consulta, ...escopo],
  );
  try {
    if (await temColunaEmbedding(query)) {
      const vetor = vetorSql(await embedder(consulta));
      const { rows: vetoriais } = await query(
        `SELECT ${COLUNAS} ${DE}
          WHERE ${FILTRO} AND m.embedding IS NOT NULL
          ORDER BY m.embedding <=> $1::vector
          LIMIT 8`,
        [vetor, ...escopo],
      );
      rows = fundirPorRrf(rows, vetoriais);
    }
  } catch {
    // Pré-migração (sem extensão/coluna) ou modelo indisponível: segue só com o full-text.
  }
  if (!rows.length) {
    const like = `%${consulta}%`;
    rows = (await query(
      `SELECT ${COLUNAS} ${DE}
        WHERE ${FILTRO}
          AND (m.title ILIKE $1 OR m.summary ILIKE $1 OR m.body_md ILIKE $1
               OR EXISTS (SELECT 1 FROM unnest(m.keywords) k WHERE k ILIKE $1))
        ORDER BY m.level ASC, m.updated_at DESC
        LIMIT 8`,
      [like, ...escopo],
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
    escopo: escopoDe(r),
    autor: r.autor ?? null,
    quando: quandoDe(r.created_at),
  }));
}

export type SalvarArgs = {
  titulo: string;
  corpo: string;
  nivel?: number | null;
  resumo?: string | null;
  keywords?: string[] | null;
  /** projeto (padrão), plataforma (universal) ou pessoa (criador da sessão). */
  escopo?: 'projeto' | 'plataforma' | 'pessoa' | null;
  /** Compat: o mesmo que escopo 'plataforma'. */
  universal?: boolean | null;
  /** Compat: o mesmo que escopo 'pessoa'. */
  sobre_pessoa?: boolean | null;
  escopo_projeto_id?: number | null;
  escopo_usuario_id?: number | null;
  /** Grava mesmo com duplicata detectada. */
  forcar?: boolean | null;
};

export type SalvarResultado =
  | { salva: true; code: string; nivel: number; nota: number | null; aviso?: string }
  | { salva: false; parecida: string; titulo: string; similaridade: number; dica: string };

/** origem: quem gravou (tool, extrator, import...); nota: inicial do micro-fato (o extrator nasce mais baixo). */
export type SalvarOpts = { origem?: string; nota?: number };

export async function salvarMemoria(
  query: MemQuery,
  ctx: MemoryToolCtx,
  args: SalvarArgs,
  embedder: Embedder = embedCorpo,
  opts: SalvarOpts = {},
): Promise<SalvarResultado> {
  const titulo = (args.titulo ?? '').trim();
  if (!titulo) throw new Error('informe o título');
  const nivel = args.nivel == null ? 4 : Number(args.nivel);
  if (nivel === 0 || nivel === 1) {
    throw new Error(
      'nível 0 (constituição) é só do Danilo e nível 1 (mapas) é só do gerador automático; a IA escreve nos níveis 2 (regra), 3 (decisão) e 4 (micro-fato)',
    );
  }
  if (![2, 3, 4].includes(nivel)) throw new Error('nivel vai de 2 a 4');
  if (args.escopo && !['projeto', 'plataforma', 'pessoa'].includes(args.escopo)) throw new Error('escopo: projeto, plataforma ou pessoa');
  const nota = nivel === 4 ? (opts.nota ?? NOTA_INICIAL) : null;
  const resumo = truncateSummary(args.resumo ?? '');
  const keywords = [...new Set((args.keywords ?? []).map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  const universal = args.escopo === 'plataforma' || !!args.universal;
  const pessoa = args.escopo === 'pessoa' || !!args.sobre_pessoa;
  // Escopo herda a sessão: por padrão a memória nasce no projeto da sessão; plataforma é a
  // exceção consciente (sem escopo nenhum); pessoa aponta pro criador da sessão (e sai do projeto,
  // porque é sobre a pessoa). Sessão neutra (sem projeto) grava na pessoa, nunca universal por
  // acaso. Os ids explícitos continuam valendo mais que tudo.
  const escopoProjeto = args.escopo_projeto_id != null
    ? Number(args.escopo_projeto_id)
    : (universal || pessoa ? null : ctx.projectId);
  const escopoUsuario = args.escopo_usuario_id != null
    ? Number(args.escopo_usuario_id)
    : (pessoa || (ctx.projectId === null && !universal && args.escopo_projeto_id == null) ? ctx.userId : null);
  const autor = ctx.autorId ?? ctx.userId;

  // Com a migração pgvector aplicada, a memória já nasce com embedding e passa pelo dedupe.
  // Best-effort: se o modelo não carregar, salva sem embedding e o backfill do deploy cobre depois.
  let temEmbedding = false;
  let embedding: string | null = null;
  let aviso: string | undefined;
  try {
    temEmbedding = await temColunaEmbedding(query);
    if (temEmbedding) {
      embedding = vetorSql(await embedder(textoDaMemoria(titulo, resumo, args.corpo ?? '')));
      const { rows: [parecida] } = await query(
        `SELECT m.code, m.title, 1 - (m.embedding <=> $1::vector) AS sim FROM memories m
          WHERE m.level BETWEEN 2 AND 4 AND m.estado = 'ativa' AND m.embedding IS NOT NULL
            AND m.scope_project_id IS NOT DISTINCT FROM $2 AND m.scope_user_id IS NOT DISTINCT FROM $3
          ORDER BY m.embedding <=> $1::vector LIMIT 1`,
        [embedding, escopoProjeto, escopoUsuario],
      );
      const sim = Number(parecida?.sim ?? 0);
      if (parecida && sim >= LIMIAR_DUPLICATA && !args.forcar) {
        return {
          salva: false, parecida: parecida.code, titulo: parecida.title, similaridade: Number(sim.toFixed(3)),
          dica: 'já existe memória quase igual neste escopo: use atualizar(code) para completar ou corrigir; se for mesmo outra coisa, salve de novo com forcar: true',
        };
      }
      if (parecida && sim >= LIMIAR_PARECIDA) aviso = `parecida com ${parecida.code} (${sim.toFixed(2)}); se for o mesmo assunto, prefira atualizar`;
    }
  } catch {
    embedding = null;
  }

  const code = await uniqueCode((sql, params) => query(sql, params), titulo);
  const comuns = [code, titulo, resumo, args.corpo ?? '', nivel, nota, keywords, escopoProjeto, escopoUsuario, autor, ctx.sessionId, opts.origem ?? 'tool'];
  if (temEmbedding && embedding) {
    await query(
      `INSERT INTO memories (code, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id, autor_user_id, sessao_origem, origem, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13::vector)`,
      [...comuns, embedding],
    );
  } else {
    await query(
      `INSERT INTO memories (code, title, summary, body_md, level, nota, rewritable, keywords, scope_project_id, scope_user_id, autor_user_id, sessao_origem, origem)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12)`,
      comuns,
    );
  }
  return { salva: true, code, nivel, nota, ...(aviso ? { aviso } : {}) };
}

export type AtualizarArgs = {
  code: string;
  titulo?: string | null;
  resumo?: string | null;
  corpo?: string | null;
  keywords?: string[] | null;
  estado?: 'ativa' | 'substituida' | null;
  motivo?: string | null;
};

export type AtualizarResultado =
  | { atualizada: true; code: string; nivel: number; campos: string[] }
  | { atualizada: false; code: string; proposta: number; tipo: string; motivo: string };

export async function atualizarMemoria(
  query: MemQuery,
  ctx: MemoryToolCtx,
  args: AtualizarArgs,
  embedder: Embedder = embedCorpo,
): Promise<AtualizarResultado> {
  const code = (args.code ?? '').trim();
  if (!code) throw new Error('informe o code da memória (vem do buscar)');
  if (args.estado && !['ativa', 'substituida'].includes(args.estado)) throw new Error('estado: ativa ou substituida');
  const titulo = typeof args.titulo === 'string' && args.titulo.trim() ? args.titulo.trim() : null;
  const resumo = typeof args.resumo === 'string' ? truncateSummary(args.resumo) : null;
  const corpo = typeof args.corpo === 'string' ? args.corpo : null;
  const keywords = Array.isArray(args.keywords)
    ? [...new Set(args.keywords.map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_KEYWORDS)
    : null;
  const estado = args.estado ?? null;
  const campos = [titulo !== null && 'titulo', resumo !== null && 'resumo', corpo !== null && 'corpo', keywords !== null && 'keywords', estado !== null && 'estado'].filter(Boolean) as string[];
  if (!campos.length) throw new Error('informe ao menos um campo: titulo, resumo, corpo, keywords ou estado');

  const { rows: [m] } = await query(
    `SELECT id, code, title, summary, body_md, level FROM memories WHERE code = $1`,
    [code],
  );
  if (!m) throw new Error(`memória ${code} não existe (confira o code pelo buscar)`);
  if (m.level === 0 || m.level === 1) throw new Error('níveis 0 e 1 não mudam pela tool: 0 é do Danilo, 1 é do gerador automático');

  const quem = `pela tool orion-memory na sessão ${ctx.sessionId} (usuário ${ctx.autorId ?? ctx.userId})${args.motivo?.trim() ? `: ${args.motivo.trim()}` : ''}`;
  if (m.level === 3) {
    // Decisão fechada só muda com aprovação: vira proposta do curador (reescrita ou deleção) no painel.
    const tipo = estado === 'substituida' ? 'delecao' : 'reescrita';
    const p = await criarProposta(query, {
      tipo,
      memoria_ids: [m.id],
      ...(tipo === 'reescrita' ? { texto: corpo ?? m.body_md, ...(resumo !== null ? { resumo } : {}) } : {}),
      justificativa: `${tipo === 'delecao' ? 'aposentar decisão' : 'atualizar decisão'} ${quem}`,
    });
    return {
      atualizada: false, code, proposta: p.id, tipo,
      motivo: 'nível 3 é decisão fechada: a mudança virou proposta e aguarda aprovação do Danilo na aba Memória (seção Curadoria)',
    };
  }

  const { rows: [nova] } = await query(
    `UPDATE memories SET
        title = COALESCE($2, title),
        summary = COALESCE($3, summary),
        corpo_anterior = CASE WHEN $4::text IS NOT NULL AND $4 <> body_md THEN body_md ELSE corpo_anterior END,
        last_rewritten_at = CASE WHEN $4::text IS NOT NULL AND $4 <> body_md THEN now() ELSE last_rewritten_at END,
        body_md = COALESCE($4, body_md),
        keywords = COALESCE($5, keywords),
        estado = COALESCE($6, estado),
        updated_at = now()
      WHERE id = $1
      RETURNING title, summary, body_md`,
    [m.id, titulo, resumo, corpo, keywords, estado],
  );
  if (titulo !== null || resumo !== null || corpo !== null) {
    try {
      if (await temColunaEmbedding(query)) {
        const v = vetorSql(await embedder(textoDaMemoria(nova.title, nova.summary ?? '', nova.body_md ?? '')));
        await query('UPDATE memories SET embedding = $2::vector WHERE id = $1', [m.id, v]);
      }
    } catch { /* busca segue no full-text; o backfill cobre */ }
  }
  return { atualizada: true, code, nivel: m.level, campos };
}

function texto(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function erro(e: unknown) {
  return { content: [{ type: 'text' as const, text: `erro: ${(e as Error)?.message ?? e}` }], isError: true };
}

export const INSTRUCOES = [
  'Memória do painel Orion. Esta sessão enxerga memórias universais (plataforma), do projeto dela e da pessoa.',
  '1. buscar(consulta): antes de supor ou perguntar. Devolve regra (nível 2), decisão (3) e micro-fato (4) com autor e data; todos_projetos: true cruza projetos.',
  '2. salvar(titulo, corpo, nivel?, escopo?): aprendeu algo durável. nivel 4 (padrão) fato curto; 2 regra; 3 só decisão fechada pela pessoa. escopo: projeto (padrão), plataforma (vale para todos os projetos: publicar, deploy, infra, memória) ou pessoa. Duplicata é recusada: use atualizar.',
  '3. atualizar(code, corpo? | resumo? | titulo? | estado?): fato mudou ou ficou errado. estado "substituida" aposenta a memória. Nível 3 vira proposta para o Danilo aprovar.',
  '4. historico(consulta): o que foi pedido, dito e decidido em sessões passadas deste projeto, com quem e quando (todos_projetos: true cruza). Use quando a pergunta for "quem decidiu", "quando", "o que combinamos".',
  'Nunca guarde segredo (token, senha, chave) em memória.',
].join('\n');

/** Servidor MCP in-process por sessão (o sessionId entra no rastro de acesso de cada busca). */
export function orionMemoryServer(pool: Pool, ctx: MemoryToolCtx): McpSdkServerConfigWithInstance {
  const query: MemQuery = (sql, params) => pool.query(sql, params as any[]);
  return createSdkMcpServer({
    name: 'orion-memory',
    version: '2.0.0',
    instructions: INSTRUCOES,
    tools: [
      tool(
        'buscar',
        'Busca memórias do painel Orion (níveis 2 a 4) por texto e por similaridade semântica, no escopo desta sessão (universal + projeto + pessoa), só as ativas. Devolve code, nível, nota, título, resumo, corpo, escopo, autor e data das 8 mais relevantes. Use antes de supor contexto, para ler o corpo de uma decisão nível 3 do índice ou para achar micro-fatos.',
        {
          consulta: z.string().describe('Palavras a buscar (título, resumo, corpo e palavras-chave; a busca semântica também entende sinônimos)'),
          nivel: z.number().int().min(2).max(4).optional().describe('Restringe a um nível: 2 regra, 3 decisão, 4 micro-fato'),
          todos_projetos: z.boolean().optional().describe('true busca também em memórias de outros projetos e de outras pessoas'),
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
        'Salva uma memória nova com autor, sessão e escopo. Níveis: 2 (regra por projeto/pessoa), 3 (decisão fechada pela pessoa) e 4 (micro-fato, padrão; nasce com nota 5). Nunca 0 e 1. Se já existir memória quase igual no mesmo escopo, não grava e devolve o code dela (use atualizar, ou forcar: true).',
        {
          titulo: z.string().describe('Título curto da memória'),
          corpo: z.string().describe('Corpo em markdown; micro-fato: 1 a 3 linhas'),
          nivel: z.number().int().min(2).max(4).optional().describe('2 regra, 3 decisão, 4 micro-fato (padrão 4)'),
          resumo: z.string().optional().describe('Resumo de até 500 caracteres (é cortado se passar)'),
          keywords: z.array(z.string()).optional().describe('Até 4 palavras-chave'),
          escopo: z.enum(['projeto', 'plataforma', 'pessoa']).optional().describe('projeto (padrão: o desta sessão), plataforma (vale para o painel inteiro e todos os projetos) ou pessoa (sobre o criador da sessão)'),
          escopo_projeto_id: z.number().int().optional().describe('id de OUTRO projeto, quando a memória não é do projeto desta sessão'),
          escopo_usuario_id: z.number().int().optional().describe('id de OUTRO usuário, quando a memória é sobre alguém que não é o criador da sessão'),
          forcar: z.boolean().optional().describe('true grava mesmo com duplicata detectada'),
        },
        async (a) => {
          try {
            return texto(await salvarMemoria(query, ctx, a));
          } catch (e) {
            return erro(e);
          }
        },
      ),
      tool(
        'atualizar',
        'Atualiza uma memória existente pelo code (vem do buscar): título, resumo, corpo, keywords ou estado. Níveis 2 e 4 mudam na hora (o corpo anterior fica guardado). Nível 3 é decisão fechada: vira proposta para o Danilo aprovar. estado "substituida" aposenta a memória (sai da busca e do prompt, fica no banco).',
        {
          code: z.string().describe('code da memória (do buscar)'),
          titulo: z.string().optional(),
          resumo: z.string().optional().describe('Até 500 caracteres'),
          corpo: z.string().optional().describe('Corpo novo completo em markdown (substitui o atual)'),
          keywords: z.array(z.string()).optional().describe('Até 4 palavras-chave (substitui as atuais)'),
          estado: z.enum(['ativa', 'substituida']).optional().describe('substituida = aposentar; ativa = reativar'),
          motivo: z.string().optional().describe('Por que mudou (entra na justificativa quando vira proposta)'),
        },
        async (a) => {
          try {
            return texto(await atualizarMemoria(query, ctx, a));
          } catch (e) {
            return erro(e);
          }
        },
      ),
      tool(
        'historico',
        'Busca no histórico das sessões do painel (o que cada pessoa pediu e o que foi respondido), por texto e por similaridade. Devolve até 8 turnos com quando, quem, projeto, título da sessão e trechos. Por padrão só o projeto desta sessão; todos_projetos: true cruza. Para "quem decidiu isso", "quando combinamos", "o que o Guilherme pediu".',
        {
          consulta: z.string().describe('O que procurar (assunto, nome de arquivo, decisão)'),
          pessoa: z.string().optional().describe('Filtra pelo nome de quem falou (ex.: Guilherme)'),
          desde: z.string().optional().describe('Só turnos a partir desta data (AAAA-MM-DD)'),
          todos_projetos: z.boolean().optional().describe('true busca em todos os projetos'),
        },
        async (a) => {
          try {
            await materializarTurnos(query).catch(() => 0); // incremental: o que terminou desde a última busca
            const turnos = await buscarHistorico(query, ctx, a);
            return texto({ encontrados: turnos.length, turnos });
          } catch (e) {
            return erro(e);
          }
        },
      ),
    ],
  });
}
