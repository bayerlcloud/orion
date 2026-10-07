// Coleta remota de mem/disco/docker das VPS fora da c3 (c1, c2, hostinger) e alerta por WhatsApp
// quando disco > 85% ou swap > 50%, uma vez por TRANSIÇÃO normal→alerta (não repete enquanto
// a condição persistir; pode alertar de novo depois de normalizar e cruzar o limite outra vez).
// Rodado a cada 15 min pelo orion-vps-remote.timer (como o usuário danilo). Lê DATABASE_URL do
// ambiente (EnvironmentFile=/etc/orion/central.env), como scripts/inventory.ts.
import { createPool } from '../server/db.js';
import { migrate } from '../server/migrations.js';
import { REMOTE_HOSTS } from '../server/dash/remoteHosts.js';
import { collectRemoteSample } from '../server/dash/remoteSample.js';
import { pontoRemoto, shouldAlert } from '../server/dash/remoteAlerta.js';
import { insertDashSample, ensureDashSamplesTable } from '../server/dash/schema.js';
import { ensureSettingsTable, getSetting, setSetting } from '../server/settings.js';
import type { Pool } from 'pg';

// ponytail: setting configurável em vez do JID real do grupo (não temos como descobrir o JID
// certo sem chamar group/fetchAllGroups e confirmar visualmente); troque pelo JID real do grupo
// de alertas via `UPDATE settings SET value = '<jid>@g.us' WHERE key = 'vps_alerta_destino'`
// (ou pela aba Configurações, quando existir um campo para isso).
const DESTINO_DEFAULT: string | null = null;

async function enviarAlertaWhatsapp(pool: Pool, texto: string): Promise<boolean> {
  const destino = (await getSetting(pool, 'vps_alerta_destino')) ?? DESTINO_DEFAULT;
  if (!destino) {
    console.log('aviso: vps_alerta_destino não configurado, não envio o alerta por whatsapp:', texto);
    return false;
  }
  try {
    const r = await fetch('http://127.0.0.1:3000/conector/whatsapp/message/sendText/alertas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: destino, text: texto }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      console.log(`aviso: alerta whatsapp respondeu ${r.status}:`, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e: any) {
    console.log('aviso: falha ao enviar alerta por whatsapp:', e?.message ?? e);
    return false;
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
      await insertDashSample(pool, host.label, pontoRemoto(sample));

      const key = `vps_alerta_${host.label}`;
      const estavaEmAlerta = (await getSetting(pool, key)) === 'true';
      const { alerta, emAlerta, motivo } = shouldAlert(
        { disk: sample.fs?.pct ?? null, swap: sample.mem?.swap_pct ?? null },
        estavaEmAlerta,
      );

      if (alerta && motivo) {
        const enviado = await enviarAlertaWhatsapp(pool, `⚠️ ${host.label}: ${motivo}`);
        if (enviado) {
          await setSetting(pool, key, 'true', null);
          console.log(`${host.label}: alerta enviado (${motivo})`);
        } else {
          console.log(`${host.label}: alerta NÃO enviado, tenta de novo no próximo ciclo (${motivo})`);
        }
      } else if (!emAlerta && estavaEmAlerta) {
        await setSetting(pool, key, 'false', null);
      }

      console.log(`${host.label}: fs=${sample.fs?.pct ?? '?'}% swap=${sample.mem?.swap_pct ?? '?'}% ` +
        `erros=[${sample.errors.join(', ')}]${alerta ? ` ALERTA: ${motivo}` : ''}`);
    } catch (e: any) {
      console.log(`${host.label}: falhou a coleta:`, e?.message ?? e);
    }
  }

  await pool.end();
}

// Guarda de execução direta: rodar main() só quando o script é executado (pelo timer/CLI),
// nunca quando é importado (ex. pelos testes, que importam só shouldAlert/pontoRemoto).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
