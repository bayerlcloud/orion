// Materializa o histórico de turnos (server/memories/historico.ts) a partir de claude_events, em
// lotes, com embedding local. Idempotente (só pega evento_id maior que o último visto):
//   DATABASE_URL=postgres://... npx tsx scripts/backfill-historico.ts
// Depois do primeiro backfill, o incremental roda pela tool historico, pelo extrator e pelo inventário.
import { createPool } from '../server/db.js';
import { ensureHistoricoTable, materializarTurnos } from '../server/memories/historico.js';

async function main() {
  const pool = createPool();
  await ensureHistoricoTable(pool);
  const q = (sql: string, params?: unknown[]) => pool.query(sql, params as any[]);
  let total = 0;
  for (;;) {
    const n = await materializarTurnos(q, { limite: 200 });
    total += n;
    console.log(`lote: ${n} turno(s)`);
    if (n < 200) break;
  }
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE embedding IS NOT NULL)::int AS emb FROM historico_turnos`);
  console.log(`histórico: ${total} novo(s) nesta rodada; ${r.n} turno(s) no total, ${r.emb} com embedding`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
