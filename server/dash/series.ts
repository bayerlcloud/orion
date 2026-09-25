// Série compacta por amostra e agregação por minuto (puro, testável).

import { MAX_KEYS, SERIES_KEYS, type Sample, type SeriesPoint } from './types.js';

export function toPoint(s: Sample): SeriesPoint {
  return {
    t: s.t,
    cpu: s.cpu?.pct ?? null, iowait: s.cpu?.iowait ?? null, steal: s.cpu?.steal ?? null,
    load1: s.load?.l1 ?? null, load5: s.load?.l5 ?? null, load15: s.load?.l15 ?? null,
    mem_used_pct: s.mem?.pct ?? null, swap_pct: s.mem?.swap_pct ?? null,
    disk_util: s.disk?.util_pct ?? null, disk_read: s.disk?.read_kbs ?? null, disk_write: s.disk?.write_kbs ?? null, fs_pct: s.disk?.fs?.pct ?? null,
    net_rx: s.net?.rx_kbs ?? null, net_tx: s.net?.tx_kbs ?? null,
    psi_cpu: s.psi?.cpu?.some10 ?? null, psi_io: s.psi?.io?.some10 ?? null, psi_mem: s.psi?.mem?.some10 ?? null,
    files_open: s.files?.open ?? null, tcp_estab: s.tcp?.estab ?? null, tcp_timewait: s.tcp?.timewait ?? null,
  };
}

export type MinuteAgg = Record<string, number | null> & { n: number; t_from: number | null; t_to: number | null };

/** Média de cada chave (ignorando nulls) e máximo (`<chave>_max`) para as chaves de MAX_KEYS. */
export function aggregateMinute(points: SeriesPoint[]): MinuteAgg {
  const list = Array.isArray(points) ? points.filter(p => p && typeof p === 'object') : [];
  const out: MinuteAgg = { n: list.length, t_from: list[0]?.t ?? null, t_to: list[list.length - 1]?.t ?? null };
  for (const k of SERIES_KEYS) {
    const vals = list.map(p => p[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    out[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100 : null;
    if (MAX_KEYS.includes(k)) out[`${k}_max`] = vals.length ? Math.max(...vals) : null;
  }
  return out;
}
