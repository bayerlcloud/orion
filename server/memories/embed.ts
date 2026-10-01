/**
 * Embeddings locais para a busca hibrida da memoria: intfloat/multilingual-e5-small via
 * transformers.js (@xenova/transformers), sem nenhuma API externa. O modelo carrega
 * preguicosamente no primeiro uso e o download fica em cache (TRANSFORMERS_CACHE, padrao
 * /home/danilo/.cache/transformers). Convencao e5: a consulta ganha o prefixo "query: " e o
 * corpo indexado ganha "passage: "; o vetor sai normalizado (norma 1), entao o operador de
 * cosseno (<=>) do pgvector ordena direito.
 *
 * A migracao que cria a coluna embedding vector(384) NAO roda no boot: ela vive em
 * server/memories/pgvector-migracao.sql (+ scripts/backfill-embeddings.ts) e quem executa e o
 * deploy do Bayerl. Antes dela, temColunaEmbedding() devolve false e tudo cai no full-text puro.
 */

export const EMBED_DIM = 384;
const MODELO = process.env.EMBED_MODEL ?? 'intfloat/multilingual-e5-small';

/** Mesma assinatura minima de query injetada que o memoryTool usa (pool real ou mock dos testes). */
export type EmbedQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

/**
 * Funcao que embeda um texto CRU (o prefixo e5 e responsabilidade da implementacao:
 * embedConsulta poe "query: ", embedCorpo poe "passage: "); injetavel nos testes, onde o
 * modelo real fica atras de RODAR_EMBED=1.
 */
export type Embedder = (texto: string) => Promise<number[]>;

let carregando: Promise<(texto: string) => Promise<number[]>> | null = null;

function carregarExtrator() {
  if (!carregando) {
    carregando = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = process.env.TRANSFORMERS_CACHE ?? '/home/danilo/.cache/transformers';
      // O repo do intfloat publica onnx/model.onnx (fp32), sem a variante quantizada que o
      // transformers.js procura por padrao; por isso quantized: false.
      const extrator = await pipeline('feature-extraction', MODELO, { quantized: false });
      return async (texto: string) => {
        const saida = await extrator(texto, { pooling: 'mean', normalize: true });
        return Array.from(saida.data as Float32Array);
      };
    })();
    // A carga falhou (sem rede e sem cache)? Zera a promise para a proxima chamada tentar de novo.
    carregando.catch(() => { carregando = null; });
  }
  return carregando;
}

/** Vetor 384 normalizado do texto (ja com o prefixo e5 que o chamador escolheu). */
export async function embed(texto: string): Promise<number[]> {
  return (await carregarExtrator())(texto);
}

/** Consulta de busca (prefixo e5 "query: "). */
export const embedConsulta: Embedder = (texto) => embed(`query: ${texto}`);

/** Corpo indexado (prefixo e5 "passage: "). */
export const embedCorpo: Embedder = (texto) => embed(`passage: ${texto}`);

/** O texto de uma memoria que vira embedding: titulo + resumo + corpo (mesma regra no salvar e no backfill). */
export function textoDaMemoria(titulo: string, resumo: string, corpo: string): string {
  return [titulo, resumo, corpo].filter(Boolean).join('\n');
}

/** Literal aceito pelo cast ::vector do pgvector. */
export function vetorSql(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** A migracao pgvector ja rodou? (a coluna memories.embedding existe) */
export async function temColunaEmbedding(query: EmbedQuery): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'embedding'`,
  );
  return rows.length > 0;
}

/**
 * Recalcula e grava o embedding de uma memoria depois de um update de corpo (best-effort:
 * sem coluna, sem modelo ou sem rede nao faz nada, e o backfill do deploy cobre depois).
 */
export async function gravarEmbedding(query: EmbedQuery, id: number, titulo: string, resumo: string, corpo: string): Promise<void> {
  try {
    if (!(await temColunaEmbedding(query))) return;
    const v = await embedCorpo(textoDaMemoria(titulo, resumo, corpo));
    await query('UPDATE memories SET embedding = $2::vector WHERE id = $1', [id, vetorSql(v)]);
  } catch { /* a busca segue no full-text; o backfill cobre */ }
}

/**
 * Reembeda uma memoria lendo o texto atual do banco: para quem muda o corpo sem ter titulo/resumo
 * na mao (reescrita aprovada, fusao do curador, espelho do nivel 1, import). Mesmo best-effort.
 */
export async function reembedar(query: EmbedQuery, id: number): Promise<void> {
  try {
    const { rows } = await query('SELECT title, summary, body_md FROM memories WHERE id = $1', [id]);
    if (rows[0]) await gravarEmbedding(query, id, rows[0].title ?? '', rows[0].summary ?? '', rows[0].body_md ?? '');
  } catch { /* idem */ }
}
