// Coleta remota de mem/disco/docker das VPS fora da c3 (c1, c2, hostinger) e alerta por WhatsApp
// quando disco > 85% ou swap > 50%, com cooldown de 1h guardado em settings. Rodado a cada 15 min
// pelo orion-vps-remote.timer (como o usuário danilo). Lê DATABASE_URL do ambiente
// (EnvironmentFile=/etc/orion/central.env), como scripts/inventory.ts.
import { createPool } from '../server/db.js';
import { migrate } from '../server/migrations.js';
import { REMOTE_HOSTS } from '../server/dash/remoteHosts.js';
import { collectRemoteSample } from '../server/dash/remoteSample.js';
import { insertDashSample, ensureDashSamplesTable } from '../server/dash/schema.js';
import { ensureSettingsTable, getSetting, setSetting } from '../server/settings.js';

const COOLDOWN_MS = 60 * 60_000;

/** Pura: decide se dispara alerta de disco/swap, respeitando o cooldown. Exportada para o teste. */
export function shouldAlert(
  pct: { disk: number | null; swap: number | null },
  lastAlertIso: string | null,
  now: number,
  cooldownMs = COOLDOWN_MS,
): { alerta: boolean; motivo: string | null } {
  const motivos: string[] = [];
  if (pct.disk !== null && pct.disk > 85) motivos.push(`disco ${pct.disk.toFixed(0)}%`);
  if (pct.swap !== null && pct.swap > 50) motivos.push(`swap ${pct.swap.toFixed(0)}%`);
  if (motivos.length === 0) return { alerta: false, motivo: null };

  const last = lastAlertIso ? Date.parse(lastAlertIso) : 0;
  if (now - last < cooldownMs) return { alerta: false, motivo: null };
  return { alerta: true, motivo: motivos.join(' e ') };
}

async function enviarAlertaWhatsapp(texto: string): Promise<void> {
  try {
    await fetch('http://127.0.0.1:3000/conector/whatsapp/message/sendText/alertas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: 'alertas@g.us', text: texto }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e: any) {
    console.log('aviso: falha ao enviar alerta por whatsapp:', e?.message ?? e);
  }
}

async function main() {
  const pool = createPool();
  await migrate(pool);
  await ensureSettingsTable(pool);
  await ensureDashSamplesTable(pool);

  for (const host of REMOTE_HOSTS) {
    try {
      const sample = await collectRemoteSample(host);
      const ponto = {
        t: Date.now(),
        mem_used_pct: sample.mem?.pct ?? null,
        swap_pct: sample.mem?.swap_pct ?? null,
        fs_pct: sample.fs?.pct ?? null,
        docker: sample.docker,
        errors: sample.errors,
      };
      await insertDashSample(pool, host.label, ponto);

      const key = `vps_alerta_${host.label}`;
      const { alerta, motivo } = shouldAlert(
        { disk: sample.fs?.pct ?? null, swap: sample.mem?.swap_pct ?? null },
        await getSetting(pool, key),
        Date.now(),
      );
      if (alerta && motivo) {
        await enviarAlertaWhatsapp(`⚠️ ${host.label}: ${motivo}`);
        await setSetting(pool, key, new Date().toISOString(), null);
      }
      console.log(`${host.label}: fs=${sample.fs?.pct ?? '?'}% swap=${sample.mem?.swap_pct ?? '?'}% ` +
        `erros=[${sample.errors.join(', ')}]${alerta ? ` ALERTA: ${motivo}` : ''}`);
    } catch (e: any) {
      console.log(`${host.label}: falhou a coleta:`, e?.message ?? e);
    }
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
