// Backup noturno dos bancos de produção dos projetos (orion-db-backup.timer, 03:00).
// Lê DATABASE_URL do ambiente (EnvironmentFile=/etc/orion/central.env), como o scripts/inventory.ts.
// Para cada projeto com db_url:<id> na tabela settings: pg_dump completo e apaga os de mais de 7 dias.
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createPool } from '../server/db.js';
import { getSetting } from '../server/settings.js';
import { dbUrlKey, dumpCompleto, limparAntigos } from '../server/dbBackup.js';

const DIR = '/srv/backups/db';
const DIAS = 7;

async function main(): Promise<number> {
  const pool = createPool();
  let falhas = 0;
  try {
    const { rows } = await pool.query<{ id: number; slug: string }>('SELECT id, slug FROM projects ORDER BY id');
    for (const p of rows) {
      const dbUrl = await getSetting(pool, dbUrlKey(p.id));
      if (!dbUrl) continue;
      const r = await dumpCompleto({ dbUrl, slug: p.slug, dir: DIR });
      if (r.ok && r.arquivo) {
        const mb = ((await stat(r.arquivo)).size / 1_048_576).toFixed(1);
        const apagados = await limparAntigos(path.join(DIR, p.slug), DIAS);
        console.log(`ok ${p.slug} ${mb} MB (${apagados} antigos apagados)`);
      } else {
        falhas++;
        console.log(`falhou ${p.slug}: ${r.erro}`);
      }
    }
  } finally {
    await pool.end();
  }
  return falhas ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
