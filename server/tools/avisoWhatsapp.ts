import type { Pool } from 'pg';
import { getSetting } from '../settings.js';

/**
 * Aviso por WhatsApp pelo conector do próprio Orion (gateway orion-wa, com fila e limites) para o destino em
 * settings.vps_alerta_destino (número ou <jid>@g.us). Veio do scripts/vpsRemoteSampler.ts para servir também ao
 * smoke pós-deploy (integracao/turno.ts). Sem destino ou com erro só registra e devolve false: nunca derruba quem chamou.
 * ponytail: setting em vez do JID fixo do grupo; troque por `UPDATE settings SET value = '<jid>@g.us' WHERE key = 'vps_alerta_destino'`.
 */
export async function enviarAvisoWhatsapp(pool: Pool, texto: string): Promise<boolean> {
  const destino = await getSetting(pool, 'vps_alerta_destino');
  if (!destino) {
    console.log('aviso: vps_alerta_destino não configurado, não envio o alerta por whatsapp:', texto);
    return false;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/conector/whatsapp/message/sendText/alertas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: destino, text: texto }),
      // 27/11/2026: 20 s, não 5. O gateway espaça os envios em 3 a 8 s (intervaloEnvio); com 3 alertas juntos o 3º
      // estourava o timeout antes de sair da fila (provado no deploy da onda A).
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      console.log(`aviso: alerta whatsapp respondeu ${r.status}:`, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.log('aviso: falha ao enviar alerta por whatsapp:', (e as Error)?.message ?? e);
    return false;
  }
}
