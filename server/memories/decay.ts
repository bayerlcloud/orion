// Decaimento diário do enxame (nível 4): micro-fato sem nenhum toque há 30 dias perde 1 de nota;
// quem chegaria a 0 morre. 100% determinístico (zero LLM), rodado pelo ciclo do orion-inventory
// DEPOIS do generateNivel1 (scripts/inventory.ts), com guarda idempotente de uma vez por dia na
// tabela settings. Nota 10 NÃO promove sozinha: promoção é do curador futuro; a UI só destaca
// "candidata a promoção".
import type { Pool } from 'pg';
import { ensureSettingsTable, getSetting, setSetting } from '../settings.js';

export const CHAVE_GUARDA = 'memoria_decaimento_ultimo_dia';
export const DIAS_SEM_TOQUE = 30;

export type ResultadoDecaimento = { pulado: boolean; decaidas: string[]; mortas: string[] };

/** "Toque" é qualquer sinal de vida: acesso, reescrita, nascimento ou o último decaimento. */
const ESTAGNADA = `greatest(coalesce(last_accessed_at, 'epoch'), coalesce(last_rewritten_at, 'epoch'), created_at, coalesce(last_decay_at, 'epoch')) < now() - interval '${DIAS_SEM_TOQUE} days'`;

/**
 * Roda o decaimento do dia (no máximo uma vez por dia, guarda em settings). A morte acontece
 * antes do decremento na mesma transação: quem está com nota 1 e estagnada chegaria a 0, e o
 * CHECK do banco (nota BETWEEN 1 AND 10) não deixa a nota encostar em 0 nem de passagem.
 */
export async function decairMicrofatos(pool: Pool, hoje = new Date().toISOString().slice(0, 10)): Promise<ResultadoDecaimento> {
  await ensureSettingsTable(pool);
  if ((await getSetting(pool, CHAVE_GUARDA)) === hoje) return { pulado: true, decaidas: [], mortas: [] };

  const client = await pool.connect();
  let decaidas: string[] = [];
  let mortas: string[] = [];
  try {
    await client.query('BEGIN');
    const del = await client.query(
      `DELETE FROM memories WHERE level = 4 AND nota <= 1 AND ${ESTAGNADA} RETURNING code`,
    );
    mortas = del.rows.map((r) => r.code);
    const upd = await client.query(
      `UPDATE memories SET nota = nota - 1, last_decay_at = now() WHERE level = 4 AND ${ESTAGNADA} RETURNING code`,
    );
    decaidas = upd.rows.map((r) => r.code);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await setSetting(pool, CHAVE_GUARDA, hoje, null);
  return { pulado: false, decaidas, mortas };
}
