import type { Pool } from 'pg';
import type { Log } from './sampler.js';

/** Cria ou migra a tabela dash_samples para o novo schema multi-host. Idempotente. */
export async function ensureDashSamplesTable(pool: Pool, log?: Log): Promise<boolean> {
  try {
    // Tabela com default host 'c3' para compatibilidade com dados antigos
    await pool.query('CREATE TABLE IF NOT EXISTS dash_samples (host text NOT NULL DEFAULT \'c3\', ts timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL, PRIMARY KEY (host, ts))');

    // Migra tabela antiga se existir: adiciona coluna host se não tiver
    await pool.query('ALTER TABLE dash_samples ADD COLUMN IF NOT EXISTS host text NOT NULL DEFAULT \'c3\'');

    // Reconstrói a chave primária para (host, ts) se ainda for só (ts)
    await pool.query('ALTER TABLE dash_samples DROP CONSTRAINT IF EXISTS dash_samples_pkey');
    await pool.query('ALTER TABLE dash_samples ADD CONSTRAINT dash_samples_pkey PRIMARY KEY (host, ts)');

    return true;
  } catch (e) {
    log?.warn({ err: String(e) }, 'dash: não criou dash_samples (segue só em memória)');
    return false;
  }
}

/** Grava uma amostra (host, now(), data) e poda dados com mais de 7 dias. Nunca lança. */
export async function insertDashSample(pool: Pool, host: string, data: unknown, log?: Log): Promise<void> {
  try {
    // INSERT com ON CONFLICT para ignorar duplicatas de (host, ts)
    // ts é DEFAULT now(), então cada chamada terá um ts único (com resolução de microssegundo)
    await pool.query(
      'INSERT INTO dash_samples (host, ts, data) VALUES ($1, now(), $2::jsonb) ON CONFLICT (host, ts) DO NOTHING',
      [host, JSON.stringify(data)]
    );

    // Poda registros com mais de 7 dias
    await pool.query("DELETE FROM dash_samples WHERE ts < now() - interval '7 days'");
  } catch (e) {
    // Loga aviso mas não lança, assim como o padrão existente em sampler.ts
    log?.warn({ err: String(e) }, 'dash: insertDashSample falhou');
  }
}
