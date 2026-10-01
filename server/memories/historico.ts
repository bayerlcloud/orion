/**
 * Histórico pesquisável das sessões (entrega 3 de docs/plans/2026-10-01-memoria-v3.md).
 *
 * claude_events guarda tudo (prompt com [Nome], hora, sessão, resposta), mas ninguém conseguia
 * buscar. Esta tabela materializa um registro por TURNO: quem falou, quando, em qual projeto, o
 * que pediu e o que o assistente respondeu (só texto, sem tool calls), com full-text em português
 * (coluna gerada + GIN) e embedding local (o mesmo e5-small da memória) para a busca híbrida.
 *
 * - materializarTurnos: incremental (evento_id > último visto), só turnos já terminados (há um
 *   `result` depois do prompt na sessão), autor pelo prefixo [Nome] casado com users.name (senão o
 *   criador da sessão). Roda sob demanda pela tool `historico`, no extrator diário e no ciclo do
 *   inventário. Embedding best-effort, como na memória.
 * - buscarHistorico: full-text + vetorial com fusão RRF (top 8), filtrada pelo projeto da sessão
 *   (todos_projetos cruza), por pessoa e por data. Devolve quem, quando, projeto, sessão e trechos.
 *
 * Lógica em funções com query injetada (tests/historico.test.ts).
 */
import type { Pool } from 'pg';
import { embedConsulta, embedCorpo, vetorSql, type Embedder } from './embed.js';

export type HQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const PROMPT_MAX = 4000;
export const RESPOSTA_MAX = 6000;
/** Quanto do turno entra no embedding (o e5-small tem janela curta; o começo do pedido e da resposta bastam). */
const EMBED_MAX = 1500;

export async function ensureHistoricoTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historico_turnos (
      id BIGSERIAL PRIMARY KEY,
      evento_id BIGINT NOT NULL,
      sessao_id TEXT NOT NULL,
      seq INT NOT NULL,
      projeto_id INT REFERENCES projects(id) ON DELETE SET NULL,
      autor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      autor_nome TEXT,
      ts TIMESTAMPTZ NOT NULL,
      prompt TEXT NOT NULL,
      resposta TEXT NOT NULL DEFAULT '',
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(prompt,'') || ' ' || coalesce(resposta,''))) STORED,
      extraido_at TIMESTAMPTZ,
      UNIQUE (sessao_id, seq)
    );
    CREATE INDEX IF NOT EXISTS historico_turnos_tsv_idx ON historico_turnos USING gin (tsv);
    CREATE INDEX IF NOT EXISTS historico_turnos_ts_idx ON historico_turnos (ts DESC);
    CREATE INDEX IF NOT EXISTS historico_turnos_evento_idx ON historico_turnos (evento_id DESC);
  `);
  // Sem pgvector (dev sem a extensão) a tabela funciona só com full-text.
  try {
    await pool.query(`ALTER TABLE historico_turnos ADD COLUMN IF NOT EXISTS embedding vector(384)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS historico_turnos_embedding_idx ON historico_turnos USING hnsw (embedding vector_cosine_ops)`);
  } catch { /* sem extensão vector: segue sem busca semântica no histórico */ }
}

export async function temEmbeddingHistorico(q: HQuery): Promise<boolean> {
  const { rows } = await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'historico_turnos' AND column_name = 'embedding'`);
  return rows.length > 0;
}

/** "[Nome] texto" vira { nome, texto }; sem prefixo, nome null. */
export function separarAutor(prompt: string): { nome: string | null; texto: string } {
  const m = /^\[([^\]]+)\]\s*/.exec(prompt ?? '');
  return m ? { nome: m[1].trim(), texto: prompt.slice(m[0].length) } : { nome: null, texto: prompt ?? '' };
}

/** Texto que vira embedding de um turno: quem + começo do pedido + começo da resposta. */
export function textoDoTurno(autor: string | null, prompt: string, resposta: string): string {
  return `${autor ? `${autor}: ` : ''}${prompt.slice(0, EMBED_MAX)}\n${resposta.slice(0, EMBED_MAX)}`;
}

/**
 * Materializa os turnos novos. Devolve quantos entraram. `limite` protege o backfill inicial
 * (roda em lotes); o incremental normal vê poucos eventos por chamada.
 */
export async function materializarTurnos(q: HQuery, opts: { limite?: number; embedder?: Embedder | null } = {}): Promise<number> {
  const limite = opts.limite ?? 500;
  const { rows: prompts } = await q(
    `SELECT e.id AS evento_id, e.session_id, e.seq, e.ts, e.payload->>'prompt' AS prompt, s.project_id, s.user_id
       FROM claude_events e JOIN claude_sessions s ON s.id = e.session_id
      WHERE e.type = 'user_prompt'
        AND e.id > (SELECT COALESCE(MAX(evento_id), 0) FROM historico_turnos)
        AND EXISTS (SELECT 1 FROM claude_events r WHERE r.session_id = e.session_id AND r.type = 'result' AND r.seq > e.seq)
      ORDER BY e.id
      LIMIT $1`,
    [limite],
  );
  if (!prompts.length) return 0;
  const { rows: pessoas } = await q('SELECT id, name FROM users');
  const idPorNome = new Map<string, number>(pessoas.map((p: any) => [String(p.name).toLowerCase(), p.id]));
  let comEmbedding = false;
  try { comEmbedding = opts.embedder !== null && await temEmbeddingHistorico(q); } catch { comEmbedding = false; }
  const embedder = opts.embedder ?? embedCorpo;

  let n = 0;
  for (const p of prompts) {
    const { nome, texto } = separarAutor(String(p.prompt ?? ''));
    if (!texto.trim() || nome === 'Orion') continue; // cutucões automáticos do painel não são turnos de gente
    const { rows: [r] } = await q(
      `SELECT string_agg(b->>'text', E'\n' ORDER BY e.seq) AS resposta
         FROM claude_events e, jsonb_array_elements(e.payload->'message'->'content') b
        WHERE e.session_id = $1 AND e.type = 'assistant' AND b->>'type' = 'text'
          AND e.seq > $2
          AND e.seq < COALESCE((SELECT MIN(seq) FROM claude_events WHERE session_id = $1 AND type = 'user_prompt' AND seq > $2), 2147483647)`,
      [p.session_id, p.seq],
    );
    const respostaCheia = String(r?.resposta ?? '');
    const resposta = respostaCheia.length > RESPOSTA_MAX ? respostaCheia.slice(-RESPOSTA_MAX) : respostaCheia;
    const autorId = (nome && idPorNome.get(nome.toLowerCase())) ?? p.user_id ?? null;
    const { rows: [ins] } = await q(
      `INSERT INTO historico_turnos (evento_id, sessao_id, seq, projeto_id, autor_user_id, autor_nome, ts, prompt, resposta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (sessao_id, seq) DO NOTHING RETURNING id`,
      [p.evento_id, p.session_id, p.seq, p.project_id ?? null, autorId, nome, p.ts, texto.slice(0, PROMPT_MAX), resposta],
    );
    if (!ins) continue;
    n++;
    if (comEmbedding) {
      try {
        const v = vetorSql(await embedder(textoDoTurno(nome, texto, resposta)));
        await q('UPDATE historico_turnos SET embedding = $2::vector WHERE id = $1', [ins.id, v]);
      } catch { /* fica só no full-text */ }
    }
  }
  return n;
}

export type TurnoEncontrado = {
  quando: string;
  quem: string | null;
  projeto: string | null;
  sessao: string | null;
  sessao_id: string;
  pedido: string;
  resposta: string;
};

const COLUNAS = `h.id, h.ts, h.autor_nome, h.sessao_id, h.prompt, h.resposta, p.slug AS projeto, s.title AS sessao`;
const DE = `FROM historico_turnos h LEFT JOIN projects p ON p.id = h.projeto_id LEFT JOIN claude_sessions s ON s.id = h.sessao_id`;
/** $2 projeto (null = sem filtro), $3 pessoa (null = sem filtro), $4 desde (null = sem filtro). */
const FILTRO = `($2::int IS NULL OR h.projeto_id = $2) AND ($3::text IS NULL OR h.autor_nome ILIKE $3) AND ($4::timestamptz IS NULL OR h.ts >= $4)`;

function rrf(...listas: Array<any[]>): any[] {
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

function trecho(s: string, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export async function buscarHistorico(
  q: HQuery,
  ctx: { projectId: number | null },
  args: { consulta: string; projeto_id?: number | null; pessoa?: string | null; desde?: string | null; todos_projetos?: boolean | null },
  embedder: Embedder = embedConsulta,
): Promise<TurnoEncontrado[]> {
  const consulta = (args.consulta ?? '').trim();
  if (!consulta) throw new Error('informe a consulta');
  const projeto = args.todos_projetos ? null : (args.projeto_id ?? ctx.projectId ?? null);
  const pessoa = args.pessoa?.trim() ? `%${args.pessoa.trim()}%` : null;
  let desde: string | null = null;
  if (args.desde?.trim()) {
    if (Number.isNaN(Date.parse(args.desde))) throw new Error('desde: use uma data como 2026-10-01');
    desde = args.desde.trim();
  }
  const filtros = [projeto, pessoa, desde];

  let { rows } = await q(
    `SELECT ${COLUNAS} ${DE}
      WHERE ${FILTRO} AND h.tsv @@ plainto_tsquery('portuguese', $1)
      ORDER BY ts_rank(h.tsv, plainto_tsquery('portuguese', $1)) DESC, h.ts DESC
      LIMIT 8`,
    [consulta, ...filtros],
  );
  try {
    if (await temEmbeddingHistorico(q)) {
      const vetor = vetorSql(await embedder(consulta));
      const { rows: vetoriais } = await q(
        `SELECT ${COLUNAS} ${DE}
          WHERE ${FILTRO} AND h.embedding IS NOT NULL
          ORDER BY h.embedding <=> $1::vector
          LIMIT 8`,
        [vetor, ...filtros],
      );
      rows = rrf(rows, vetoriais);
    }
  } catch { /* sem vetor: só full-text */ }
  if (!rows.length) {
    rows = (await q(
      `SELECT ${COLUNAS} ${DE}
        WHERE ${FILTRO} AND (h.prompt ILIKE $1 OR h.resposta ILIKE $1)
        ORDER BY h.ts DESC LIMIT 8`,
      [`%${consulta}%`, ...filtros],
    )).rows;
  }
  return rows.map((r) => ({
    quando: r.ts instanceof Date ? r.ts.toISOString().slice(0, 16).replace('T', ' ') : String(r.ts ?? '').slice(0, 16).replace('T', ' '),
    quem: r.autor_nome ?? null,
    projeto: r.projeto ?? null,
    sessao: r.sessao ?? null,
    sessao_id: r.sessao_id,
    pedido: trecho(r.prompt, 300),
    resposta: trecho(r.resposta, 500),
  }));
}
