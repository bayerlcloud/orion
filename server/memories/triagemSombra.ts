/**
 * Piloto Laya (docs/plans/2026-10-07-piloto-laya-triagem.md): modo sombra. Grava o que o
 * classificador decidiria, nunca o texto do prompt. `seq` nasce nulo porque o hook
 * UserPromptSubmit roda antes do evento do turno existir em claude_events/historico_turnos;
 * a junção com `seq` acontece depois, por timestamp (ver Task 5 do plano).
 */
import type { Pool } from 'pg';

export async function ensureTriagemSombraTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS triagem_sombra (
    id BIGSERIAL PRIMARY KEY,
    sessao_id TEXT NOT NULL,
    seq INTEGER,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    latencia_ms INTEGER,
    respostas JSONB NOT NULL,
    modelo_usado TEXT,
    esforco_usado TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS triagem_sombra_sessao_ts_idx ON triagem_sombra (sessao_id, ts)');
}

export type TriagemSombraRow = {
  sessaoId: string;
  ts: Date;
  latenciaMs: number | null;
  respostas: unknown;
  modeloUsado: string | null;
  esforcoUsado: string | null;
};

export async function gravarTriagemSombra(pool: Pool, row: TriagemSombraRow): Promise<void> {
  await pool.query(
    'INSERT INTO triagem_sombra (sessao_id, ts, latencia_ms, respostas, modelo_usado, esforco_usado) VALUES ($1, $2, $3, $4, $5, $6)',
    [row.sessaoId, row.ts, row.latenciaMs, JSON.stringify(row.respostas), row.modeloUsado, row.esforcoUsado],
  );
}
