// Migração do esquema antigo (status deus/aprendizagem/rascunho + learning_level) para a
// pirâmide de níveis 0-4 com nota exclusiva do nível 4 (decisões fechadas 28/09/2026).
// Idempotente: roda em todo boot (chamada por routes/memories.ts, como o CREATE TABLE), e é
// segura para rodar duas vezes. O mapeamento linha a linha é uma função pura, testável
// isoladamente (tests/memoriesMigrate.test.ts).
import type { Pool } from 'pg';
import { NOTA_INICIAL } from './util.js';

export type LinhaAntiga = {
  code: string;
  status: string;
  learning_level: number | null;
  scope_project_id: number | null;
  scope_user_id: number | null;
};

/**
 * Para onde vai cada linha do esquema antigo. Primeiro os codes conhecidos (mapeamento fechado
 * com o Danilo), depois a regra geral: aprendizagem vira 3 quando tem escopo (senão 4 nota 5),
 * rascunho vira 4 nota 5, deus vira 3.
 */
export function mapearNivel(m: LinhaAntiga): { level: number; nota: number | null } {
  if (m.code === 'constituicao-nivel-0') return { level: 0, nota: null };
  if (m.code.startsWith('nivel1-')) return { level: 1, nota: null };
  if (m.code === 'danilo-role' || m.code === 'orion-project') return { level: 2, nota: null };
  if (m.code === 'orion-central-unico-painel') return { level: 3, nota: null };
  if (m.status === 'deus') return { level: 3, nota: null };
  if (m.status === 'aprendizagem' && (m.scope_project_id != null || m.scope_user_id != null)) {
    return { level: 3, nota: null };
  }
  return { level: 4, nota: NOTA_INICIAL }; // aprendizagem sem escopo, rascunho e qualquer sobra
}

/**
 * Leva a tabela memories ao esquema novo, venha ela do CREATE TABLE novo (no-op) ou do antigo:
 * adiciona level/nota/last_decay_at, migra as linhas pelo mapeamento acima, remove
 * status/learning_level com seus CHECKs e fecha com as constraints novas.
 */
export async function ensureMemoriesSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS level INT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS nota INT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS autor_user_id INT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS sessao_origem TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'painel';
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS corpo_anterior TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'ativa';
  `);
  // Memória v3 (docs/plans/2026-10-01-memoria-v3.md): quem gerou, de onde veio, estado e desfazer.
  // origem: painel | tool | extrator | import | curador | nivel1. estado: ativa | substituida
  // (substituída sai da busca e do índice do prompt, fica no banco).
  const { rowCount: temEstadoCk } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'memories_estado_ck'`);
  if (!temEstadoCk) {
    await pool.query(`ALTER TABLE memories ADD CONSTRAINT memories_estado_ck CHECK (estado IN ('ativa','substituida'))`);
  }

  const { rowCount: temStatus } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'status'`,
  );
  if (temStatus) {
    const { rows } = await pool.query<LinhaAntiga & { id: number }>(
      `SELECT id, code, status, learning_level, scope_project_id, scope_user_id FROM memories WHERE level IS NULL`,
    );
    for (const r of rows) {
      const { level, nota } = mapearNivel(r);
      await pool.query('UPDATE memories SET level = $2, nota = $3 WHERE id = $1', [r.id, level, nota]);
    }
    await pool.query(`
      ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_level_ck;
      ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_status_check;
      ALTER TABLE memories DROP COLUMN IF EXISTS status;
      ALTER TABLE memories DROP COLUMN IF EXISTS learning_level;
    `);
  }

  // Acabamento idempotente, vale para os dois caminhos (tabela migrada ou já no esquema novo).
  await pool.query(`UPDATE memories SET level = 4 WHERE level IS NULL`);
  await pool.query(`UPDATE memories SET nota = ${NOTA_INICIAL} WHERE level = 4 AND nota IS NULL`);
  await pool.query(`UPDATE memories SET nota = NULL WHERE level <> 4 AND nota IS NOT NULL`);
  await pool.query(`ALTER TABLE memories ALTER COLUMN level SET NOT NULL`);
  await pool.query(`ALTER TABLE memories ALTER COLUMN level SET DEFAULT 4`);

  const { rowCount: temNivelCk } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'memories_nivel_ck'`);
  if (!temNivelCk) {
    await pool.query(`ALTER TABLE memories ADD CONSTRAINT memories_nivel_ck CHECK (level BETWEEN 0 AND 4)`);
  }
  const { rowCount: temNotaCk } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'memories_nota_ck'`);
  if (!temNotaCk) {
    await pool.query(
      `ALTER TABLE memories ADD CONSTRAINT memories_nota_ck CHECK ((level = 4 AND nota BETWEEN 1 AND 10) OR (level <> 4 AND nota IS NULL))`,
    );
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_level_idx ON memories (level, nota DESC)`);
}
