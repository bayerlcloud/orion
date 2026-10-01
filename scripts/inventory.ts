// Coleta o inventário da VPS e guarda um snapshot. Rodado a cada hora pelo orion-inventory.timer (como o usuário danilo).
// Lê DATABASE_URL do ambiente (EnvironmentFile=/etc/orion/central.env), como o scripts/seed.ts.
// Depois do snapshot, regenera os arquivos de contexto do nível 1 (server/nivel1/generate.ts) no mesmo ciclo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../server/db.js';
import { migrate } from '../server/migrations.js';
import { collectInventory, saveSnapshot, SNAPSHOTS_GUARDADOS } from '../server/inventory.js';
import { generateNivel1 } from '../server/nivel1/generate.js';
import { decairMicrofatos } from '../server/memories/decay.js';
import { ensureHistoricoTable, materializarTurnos } from '../server/memories/historico.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const pool = createPool();
  await migrate(pool);
  const repoDir = process.env.ORION_REPO ?? path.resolve(here, '..', '..');
  const inicio = Date.now();
  const data = await collectInventory(pool, repoDir, 'timer');
  const { id, ts } = await saveSnapshot(pool, data, SNAPSHOTS_GUARDADOS);
  console.log(
    `snapshot ${id} em ${ts} (${Math.round((Date.now() - inicio) / 100) / 10}s): ` +
    `${data.binarios.length} binários, ${data.pacotes.length} pacotes globais, ${data.servicos.length} unidades, ` +
    `${data.containers.length} containers, ${data.portas.length} portas, ${data.apt.length} eventos apt`);
  for (const a of data.avisos) console.log('aviso:', a);

  // Nível 1: aproveita o pool e a versão do claude que o inventário acabou de coletar. Nunca lança.
  const nivel1 = await generateNivel1(pool, data.binarios);
  console.log(`nível 1: ${nivel1.escritos.length ? `regenerados ${nivel1.escritos.join(', ')}` : 'nada regenerado'}`);
  for (const a of nivel1.avisos) console.log('aviso nível 1:', a);

  // Decaimento diário do enxame (nível 4): determinístico, com guarda de 1x/dia. Nunca aborta o ciclo.
  try {
    const decay = await decairMicrofatos(pool);
    if (decay.pulado) console.log('decaimento nível 4: já rodou hoje, nada a fazer');
    else console.log(
      `decaimento nível 4: ${decay.decaidas.length} decaíram${decay.decaidas.length ? ` (${decay.decaidas.join(', ')})` : ''}, ` +
      `${decay.mortas.length} morreram${decay.mortas.length ? ` (${decay.mortas.join(', ')})` : ''}`);
  } catch (e: any) {
    console.log('aviso decaimento nível 4:', e?.message ?? e);
  }

  // Histórico pesquisável (memória v3): materializa os turnos terminados desde a última vez, com embedding local.
  try {
    await ensureHistoricoTable(pool);
    const n = await materializarTurnos((sql, params) => pool.query(sql, params as any[]));
    console.log(`histórico: ${n} turno(s) novo(s)`);
  } catch (e: any) {
    console.log('aviso histórico:', e?.message ?? e);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
