// Lógica pura (sem efeito colateral de I/O) usada por scripts/vpsRemoteSampler.ts.
// Mora num módulo separado do script para poder ser importada pelos testes sem
// disparar nenhuma coleta real, migração de banco ou envio de WhatsApp.
import type { RemoteSample } from './remoteSample.js';

/** Monta o ponto gravado em dash_samples a partir de uma amostra remota. Campos lidos por web/src/pages/Dash.tsx. */
export function pontoRemoto(sample: RemoteSample): {
  t: number;
  mem_used_pct: number | null;
  swap_pct: number | null;
  fs_pct: number | null;
  docker: RemoteSample['docker'];
  errors: string[];
} {
  return {
    t: Date.now(),
    mem_used_pct: sample.mem?.pct ?? null,
    swap_pct: sample.mem?.swap_pct ?? null,
    fs_pct: sample.fs?.pct ?? null,
    docker: sample.docker,
    errors: sample.errors,
  };
}

/**
 * Decide se dispara alerta de disco/swap, por TRANSIÇÃO normal→alerta (não por tempo):
 * só alerta quando a condição vira "em alerta" depois de estar normal; enquanto permanecer
 * em alerta não repete; depois de normalizar, pode alertar de novo se cruzar o limite outra vez.
 * `estavaEmAlerta` é o estado anterior (lido do setting `vps_alerta_<host>`, 'true'/outro).
 */
export function shouldAlert(
  pct: { disk: number | null; swap: number | null },
  estavaEmAlerta: boolean,
): { alerta: boolean; emAlerta: boolean; motivo: string | null } {
  const motivos: string[] = [];
  if (pct.disk !== null && pct.disk > 85) motivos.push(`disco ${pct.disk.toFixed(0)}%`);
  if (pct.swap !== null && pct.swap > 50) motivos.push(`swap ${pct.swap.toFixed(0)}%`);
  const emAlerta = motivos.length > 0;

  if (!emAlerta) return { alerta: false, emAlerta: false, motivo: null };
  if (estavaEmAlerta) return { alerta: false, emAlerta: true, motivo: null };
  return { alerta: true, emAlerta: true, motivo: motivos.join(' e ') };
}
