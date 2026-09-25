// Coleta o inventário da VPS e guarda um snapshot. Rodado a cada hora pelo orion-inventory.timer (como o usuário danilo).
// Lê DATABASE_URL do ambiente (EnvironmentFile=/etc/orion/central.env), como o scripts/seed.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../server/db.js';
import { migrate } from '../server/migrations.js';
import { collectInventory, saveSnapshot, SNAPSHOTS_GUARDADOS } from '../server/inventory.js';

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
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
