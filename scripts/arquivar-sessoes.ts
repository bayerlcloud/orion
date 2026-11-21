// Arquiva sessões paradas há mais de 30 dias (orion-arquivar-sessoes.timer, diário 03:20 UTC).
import { createPool } from '../server/db.js';
import { arquivarSessoesPassadas, DIAS_PADRAO } from '../server/sessoesInativas.js';

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const n = await arquivarSessoesPassadas(pool, DIAS_PADRAO);
    console.log(`arquivar-sessoes: ${n} sessão(ões) arquivada(s) (paradas há mais de ${DIAS_PADRAO} dias)`);
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
