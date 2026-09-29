/**
 * Propostas de curadoria da memória (tabela curadoria_propostas): o curador (server/curador/run.ts)
 * grava propostas e o Danilo decide no painel (server/routes/curadoria.ts). Tudo ADITIVO: nenhuma
 * mudança no schema de memories. As validações vivem AQUI, no servidor, nunca no modelo:
 * níveis 0 e 1 são intocáveis, promoção é só de nível 4, reescrita exige rewritable.
 * A lógica recebe uma query mínima injetada para os testes rodarem com pool mockado
 * (tests/curadoria.test.ts), mesmo padrão de memoryTool.ts.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../memories/util.js';

export type CurQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const TIPOS_PROPOSTA = ['promocao', 'reescrita', 'delecao', 'conflito'] as const;
export type TipoProposta = (typeof TIPOS_PROPOSTA)[number];

/** Retrato da memória na hora da proposta: sobrevive à deleção para o painel exibir. */
export type MemoriaSnapshot = { id: number; code: string; title: string; level: number; nota: number | null };

export type PropostaPayload = {
  memoria_ids: number[];
  memorias: MemoriaSnapshot[];
  texto?: string;
  justificativa?: string;
};

/** Tabela nasce no boot (rota) e no curador, como as outras do projeto (CREATE TABLE IF NOT EXISTS). */
export async function ensureCuradoriaTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS curadoria_propostas (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL CHECK (tipo IN ('promocao','reescrita','delecao','conflito')),
      payload JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','rejeitada')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      decided_by INT REFERENCES users(id),
      applied_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS curadoria_propostas_status_idx ON curadoria_propostas (status, created_at DESC);
  `);
}

function idsValidos(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError('memoria_ids precisa ser uma lista com ao menos 1 id');
  const ids = [...new Set(v.map((x) => Number(x)))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new ValidationError('memoria_ids precisa conter só inteiros positivos');
  if (ids.length > 10) throw new ValidationError('no máximo 10 memórias por proposta');
  return ids;
}

/** Busca as memórias citadas e barra qualquer toque nos níveis 0 e 1 (intocáveis pelo curador). */
export async function snapshotMemorias(q: CurQuery, ids: number[]): Promise<MemoriaSnapshot[]> {
  const { rows } = await q(
    'SELECT id, code, title, level, nota, rewritable FROM memories WHERE id = ANY($1) ORDER BY id',
    [ids],
  );
  if (rows.length !== ids.length) {
    const achados = new Set(rows.map((r: any) => r.id));
    const faltam = ids.filter((i) => !achados.has(i));
    throw new ValidationError(`memória(s) inexistente(s): ${faltam.join(', ')}`);
  }
  const intocavel = rows.find((r: any) => r.level === 0 || r.level === 1);
  if (intocavel) throw new ValidationError(`níveis 0 e 1 são intocáveis pela curadoria (memória ${intocavel.code})`);
  return rows as MemoriaSnapshot[];
}

/**
 * Cria uma proposta pendente, com todas as validações por tipo feitas no servidor.
 * Devolve o id e o payload gravado (com o snapshot das memórias para o painel).
 */
export async function criarProposta(
  q: CurQuery,
  args: { tipo: unknown; memoria_ids: unknown; texto?: unknown; justificativa?: unknown },
): Promise<{ id: number; tipo: TipoProposta; payload: PropostaPayload }> {
  const tipo = String(args.tipo ?? '') as TipoProposta;
  if (!TIPOS_PROPOSTA.includes(tipo)) {
    throw new ValidationError(`tipo inválido; use um de: ${TIPOS_PROPOSTA.join(', ')}`);
  }
  const justificativa = typeof args.justificativa === 'string' ? args.justificativa.trim() : '';
  if (!justificativa) throw new ValidationError('justificativa é obrigatória');
  const texto = typeof args.texto === 'string' ? args.texto : undefined;
  const ids = idsValidos(args.memoria_ids);
  const memorias = await snapshotMemorias(q, ids);

  if (tipo === 'promocao') {
    if (ids.length !== 1) throw new ValidationError('promoção envolve exatamente 1 memória');
    if (memorias[0].level !== 4) throw new ValidationError('promoção é só de micro-fato (nível 4) para decisão (nível 3)');
  }
  if (tipo === 'reescrita') {
    if (ids.length !== 1) throw new ValidationError('reescrita envolve exatamente 1 memória');
    if (!texto || !texto.trim()) throw new ValidationError('reescrita exige o texto novo completo em texto');
    if (!(memorias[0] as any).rewritable) throw new ValidationError('esta memória está marcada como não reescrevível pela IA');
  }
  if (tipo === 'conflito' && ids.length < 2) {
    throw new ValidationError('conflito envolve ao menos 2 memórias');
  }

  const payload: PropostaPayload = {
    memoria_ids: ids,
    memorias: memorias.map(({ id, code, title, level, nota }) => ({ id, code, title, level, nota })),
    ...(texto !== undefined ? { texto } : {}),
    justificativa,
  };
  const { rows } = await q(
    `INSERT INTO curadoria_propostas (tipo, payload) VALUES ($1, $2) RETURNING id`,
    [tipo, JSON.stringify(payload)],
  );
  return { id: rows[0].id, tipo, payload };
}

/**
 * Aplica uma proposta aprovada. Revalida TUDO contra o estado atual do banco (a memória pode ter
 * mudado desde a proposta): promoção exige que ainda seja nível 4, reescrita que ainda seja
 * rewritable, deleção nunca encosta em nível < 2. Conflito não aplica nada (a resolução real é
 * do Danilo, editando as memórias). Deve rodar dentro da transação de quem aprova.
 */
export async function aplicarProposta(
  q: CurQuery,
  proposta: { tipo: TipoProposta; payload: PropostaPayload },
): Promise<string> {
  const { tipo, payload } = proposta;
  const ids = idsValidos(payload?.memoria_ids);

  if (tipo === 'promocao') {
    const { rows } = await q(
      `UPDATE memories SET level = 3, nota = NULL, updated_at = now() WHERE id = $1 AND level = 4 RETURNING code`,
      [ids[0]],
    );
    if (!rows.length) throw new ValidationError('a memória não é mais um micro-fato nível 4 (ou não existe mais)');
    return `memória ${rows[0].code} promovida para decisão (nível 3)`;
  }
  if (tipo === 'reescrita') {
    const texto = typeof payload.texto === 'string' ? payload.texto : '';
    if (!texto.trim()) throw new ValidationError('proposta de reescrita sem texto');
    const { rows } = await q(
      `UPDATE memories SET body_md = $2, last_rewritten_at = now(), updated_at = now()
        WHERE id = $1 AND level >= 2 AND rewritable RETURNING code`,
      [ids[0], texto],
    );
    if (!rows.length) throw new ValidationError('a memória não existe mais ou deixou de ser reescrevível');
    return `memória ${rows[0].code} reescrita`;
  }
  if (tipo === 'delecao') {
    // O WHERE nunca deixa a deleção encostar nos níveis 0 e 1, mesmo que o payload venha errado.
    const { rows } = await q(`DELETE FROM memories WHERE id = ANY($1) AND level >= 2 RETURNING code`, [ids]);
    if (!rows.length) throw new ValidationError('nenhuma das memórias existe mais (nada a excluir)');
    return `excluída(s): ${rows.map((r: any) => r.code).join(', ')}`;
  }
  // conflito: só marcado como resolvido; nada muda nas memórias.
  return 'conflito marcado como resolvido (as memórias não foram alteradas)';
}
