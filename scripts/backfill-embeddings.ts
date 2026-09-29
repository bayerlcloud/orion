// Backfill dos embeddings da memoria: embeda toda memoria sem embedding (coluna criada por
// server/memories/pgvector-migracao.sql). NAO roda no boot; quem executa e o deploy do Bayerl:
//   DATABASE_URL=postgres://... npx tsx scripts/backfill-embeddings.ts
// Idempotente: pode rodar de novo a qualquer momento (so pega WHERE embedding IS NULL).
import { createPool } from '../server/db.js';
import { embedCorpo, textoDaMemoria, vetorSql } from '../server/memories/embed.js';

async function main() {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT id, title, summary, body_md FROM memories WHERE embedding IS NULL ORDER BY id`,
  );
  if (!rows.length) {
    console.log('nada a fazer: toda memoria ja tem embedding');
    await pool.end();
    return;
  }
  let n = 0;
  for (const m of rows) {
    const v = await embedCorpo(textoDaMemoria(m.title ?? '', m.summary ?? '', m.body_md ?? ''));
    await pool.query('UPDATE memories SET embedding = $2::vector WHERE id = $1', [m.id, vetorSql(v)]);
    n++;
    if (n % 25 === 0) console.log(`${n}/${rows.length}...`);
  }
  console.log(`embeddings gravados: ${n} de ${rows.length}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
