/**
 * Propostas de curadoria da memória (tabela curadoria_propostas): o curador (server/curador/run.ts)
 * grava propostas e o Danilo decide no painel (server/routes/curadoria.ts). Tudo ADITIVO: nenhuma
 * mudança no schema de memories. As validações vivem AQUI, no servidor, nunca no modelo:
 * níveis 0 e 1 são intocáveis, promoção é só de nível 4, reescrita exige rewritable.
 * A lógica recebe uma query mínima injetada para os testes rodarem com pool mockado
 * (tests/curadoria.test.ts), mesmo padrão de memoryTool.ts.
 */
import type { Pool } from 'pg';
import { ValidationError, normalizeScopeId, truncateSummary } from '../memories/util.js';

export type CurQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const TIPOS_PROPOSTA = ['promocao', 'reescrita', 'delecao', 'conflito', 'reescopo'] as const;
export type TipoProposta = (typeof TIPOS_PROPOSTA)[number];

/** Cláusula CHECK de tipo, uma só fonte para o CREATE TABLE e para a migração abaixo. */
const TIPO_CHECK = `CHECK (tipo IN (${TIPOS_PROPOSTA.map((t) => `'${t}'`).join(',')}))`;

/** Retrato da memória na hora da proposta: sobrevive à deleção para o painel exibir. */
export type MemoriaSnapshot = { id: number; code: string; title: string; level: number; nota: number | null };

/** Escopo proposto num reescopo, já normalizado: projeto OU usuário OU universal (os dois null). */
export type EscopoNovo = { scope_project_id: number | null; scope_user_id: number | null };

export type PropostaPayload = {
  memoria_ids: number[];
  memorias: MemoriaSnapshot[];
  texto?: string;
  resumo?: string;
  escopo_novo?: EscopoNovo;
  justificativa?: string;
};

/**
 * Tabela nasce no boot (rota) e no curador, como as outras do projeto (CREATE TABLE IF NOT EXISTS).
 * O CHECK de tipo é recriado a cada boot (DROP IF EXISTS + ADD, migração idempotente): tabelas
 * criadas antes do tipo reescopo ganham a lista nova sem tocar em nenhuma linha.
 */
export async function ensureCuradoriaTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS curadoria_propostas (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL ${TIPO_CHECK},
      payload JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','rejeitada')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      decided_by INT REFERENCES users(id),
      applied_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS curadoria_propostas_status_idx ON curadoria_propostas (status, created_at DESC);
    ALTER TABLE curadoria_propostas DROP CONSTRAINT IF EXISTS curadoria_propostas_tipo_check;
    ALTER TABLE curadoria_propostas ADD CONSTRAINT curadoria_propostas_tipo_check ${TIPO_CHECK};
  `);
}

/**
 * Valida e normaliza o escopo_novo de um reescopo. Formas aceitas: { scope_project_id },
 * { scope_user_id } ou { universal: true }. Universal precisa ser explícito para um objeto
 * vazio (modelo confuso) nunca virar "apaga o escopo".
 */
export function normalizarEscopoNovo(v: unknown): EscopoNovo {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new ValidationError('escopo_novo precisa ser um objeto: { scope_project_id }, { scope_user_id } ou { universal: true }');
  }
  const o = v as Record<string, unknown>;
  const proj = normalizeScopeId(o.scope_project_id);
  const user = normalizeScopeId(o.scope_user_id);
  const universal = o.universal === true;
  if (proj !== null && user !== null) throw new ValidationError('escopo_novo aceita projeto OU usuário, nunca os dois');
  if (universal && (proj !== null || user !== null)) throw new ValidationError('universal: true não combina com um id de escopo');
  if (!universal && proj === null && user === null) {
    throw new ValidationError('escopo_novo precisa indicar scope_project_id, scope_user_id ou universal: true');
  }
  return { scope_project_id: proj, scope_user_id: user };
}

/** Descrição curta do escopo para mensagens e log. */
export function descreverEscopo(e: EscopoNovo): string {
  if (e.scope_project_id !== null) return `projeto ${e.scope_project_id}`;
  if (e.scope_user_id !== null) return `usuário ${e.scope_user_id}`;
  return 'universal';
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
    'SELECT id, code, title, level, nota, rewritable, scope_project_id, scope_user_id FROM memories WHERE id = ANY($1) ORDER BY id',
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
  args: { tipo: unknown; memoria_ids: unknown; texto?: unknown; resumo?: unknown; escopo_novo?: unknown; justificativa?: unknown },
): Promise<{ id: number; tipo: TipoProposta; payload: PropostaPayload }> {
  const tipo = String(args.tipo ?? '') as TipoProposta;
  if (!TIPOS_PROPOSTA.includes(tipo)) {
    throw new ValidationError(`tipo inválido; use um de: ${TIPOS_PROPOSTA.join(', ')}`);
  }
  const justificativa = typeof args.justificativa === 'string' ? args.justificativa.trim() : '';
  if (!justificativa) throw new ValidationError('justificativa é obrigatória');
  const texto = typeof args.texto === 'string' ? args.texto : undefined;
  const resumo = tipo === 'reescrita' && typeof args.resumo === 'string' && args.resumo.trim() ? args.resumo.trim() : undefined;
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
  let escopo: EscopoNovo | undefined;
  if (tipo === 'reescopo') {
    if (ids.length !== 1) throw new ValidationError('reescopo envolve exatamente 1 memória');
    escopo = normalizarEscopoNovo(args.escopo_novo);
    // snapshotMemorias já barrou níveis 0 e 1, então aqui a memória é sempre nível >= 2.
    const atual = memorias[0] as MemoriaSnapshot & { scope_project_id?: number | null; scope_user_id?: number | null };
    if ((atual.scope_project_id ?? null) === escopo.scope_project_id && (atual.scope_user_id ?? null) === escopo.scope_user_id) {
      throw new ValidationError('a memória já tem exatamente esse escopo');
    }
    if (escopo.scope_project_id !== null) {
      const { rowCount } = await q('SELECT 1 FROM projects WHERE id = $1', [escopo.scope_project_id]);
      if (!rowCount) throw new ValidationError(`projeto ${escopo.scope_project_id} não existe`);
    }
    if (escopo.scope_user_id !== null) {
      const { rowCount } = await q('SELECT 1 FROM users WHERE id = $1', [escopo.scope_user_id]);
      if (!rowCount) throw new ValidationError(`usuário ${escopo.scope_user_id} não existe`);
    }
  }

  const payload: PropostaPayload = {
    memoria_ids: ids,
    memorias: memorias.map(({ id, code, title, level, nota }) => ({ id, code, title, level, nota })),
    ...(texto !== undefined ? { texto } : {}),
    ...(resumo !== undefined ? { resumo } : {}),
    ...(escopo !== undefined ? { escopo_novo: escopo } : {}),
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
 * rewritable, deleção nunca encosta em nível < 2, reescopo só em memória viva de nível >= 2.
 * Conflito não aplica nada (a resolução real é do Danilo, editando as memórias).
 * Deve rodar dentro da transação de quem aprova.
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
    // Resumo novo é opcional: sem ele, o resumo antigo fica (e pode contradizer o corpo novo).
    const resumo = typeof payload.resumo === 'string' && payload.resumo.trim() ? truncateSummary(payload.resumo.trim()) : null;
    const { rows } = await q(
      `UPDATE memories SET body_md = $2, summary = COALESCE($3, summary), last_rewritten_at = now(), updated_at = now()
        WHERE id = $1 AND level >= 2 AND rewritable RETURNING code`,
      [ids[0], texto, resumo],
    );
    if (!rows.length) throw new ValidationError('a memória não existe mais ou deixou de ser reescrevível');
    return `memória ${rows[0].code} reescrita`;
  }
  if (tipo === 'reescopo') {
    // Revalida o escopo do payload, que já está na forma NORMALIZADA (criarProposta):
    // os dois null significam universal, então aqui não se exige o universal: true da entrada.
    const bruto = payload.escopo_novo as Record<string, unknown> | undefined;
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
      throw new ValidationError('proposta de reescopo sem escopo_novo válido');
    }
    if (!('scope_project_id' in bruto) && !('scope_user_id' in bruto) && bruto.universal !== true) {
      throw new ValidationError('proposta de reescopo sem escopo_novo válido');
    }
    const proj = normalizeScopeId(bruto.scope_project_id);
    const user = normalizeScopeId(bruto.scope_user_id);
    if (proj !== null && user !== null) throw new ValidationError('escopo_novo aceita projeto OU usuário, nunca os dois');
    const escopo: EscopoNovo = { scope_project_id: proj, scope_user_id: user };
    const { rows } = await q(
      `UPDATE memories SET scope_project_id = $2, scope_user_id = $3, updated_at = now()
        WHERE id = $1 AND level >= 2 RETURNING code`,
      [ids[0], escopo.scope_project_id, escopo.scope_user_id],
    );
    if (!rows.length) throw new ValidationError('a memória não existe mais (ou virou nível intocável)');
    return `memória ${rows[0].code} reescopada para ${descreverEscopo(escopo)}`;
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
