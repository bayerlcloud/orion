// Tipos compartilhados do Dash (amostra completa e ponto de série).

export type ProcRow = { pid: number; name: string; user: string | null; state: string; threads: number; cpu: number | null; rss: number };

export type Sample = {
  ts: string;
  t: number;
  host: { hostname: string; kernel: string; uptime_s: number; vcpus: number; label: string; ip: string };
  cpu: { pct: number; iowait: number; steal: number } | null;
  load: { l1: number; l5: number; l15: number; running: number; threads: number } | null;
  mem: { total: number; used: number; available: number; pct: number; buffers: number; cached: number; swap_total: number; swap_used: number; swap_pct: number } | null;
  psi: {
    cpu: { some10: number; some60: number } | null;
    io: { some10: number; some60: number; full10: number | null; full60: number | null } | null;
    mem: { some10: number; some60: number; full10: number | null; full60: number | null } | null;
  };
  disk: {
    device: string | null;
    read_kbs: number | null; write_kbs: number | null; util_pct: number | null;
    fs: { total: number; used: number; avail: number; pct: number } | null;
  };
  net: { iface: string | null; rx_kbs: number | null; tx_kbs: number | null };
  files: { open: number; max: number } | null;
  tcp: { total: number | null; estab: number | null; timewait: number | null; orphaned: number | null } | null;
  procs: { top_cpu: ProcRow[]; top_mem: ProcRow[]; count: number };
  docker: { name: string; status: string; state: string; image: string }[] | null;
  units: { unit: string; load: string; active: string; sub: string; description: string }[] | null;
  errors: string[];
};

/** Ponto compacto usado nas sparklines e na agregação por minuto. */
export type SeriesPoint = {
  t: number;
  cpu: number | null; iowait: number | null; steal: number | null;
  load1: number | null; load5: number | null; load15: number | null;
  mem_used_pct: number | null; swap_pct: number | null;
  disk_util: number | null; disk_read: number | null; disk_write: number | null; fs_pct: number | null;
  net_rx: number | null; net_tx: number | null;
  psi_cpu: number | null; psi_io: number | null; psi_mem: number | null;
  files_open: number | null; tcp_estab: number | null; tcp_timewait: number | null;
};

export const SERIES_KEYS: (keyof Omit<SeriesPoint, 't'>)[] = [
  'cpu', 'iowait', 'steal', 'load1', 'load5', 'load15', 'mem_used_pct', 'swap_pct',
  'disk_util', 'disk_read', 'disk_write', 'fs_pct', 'net_rx', 'net_tx',
  'psi_cpu', 'psi_io', 'psi_mem', 'files_open', 'tcp_estab', 'tcp_timewait',
];

/** Chaves que também guardam o máximo do minuto (para "pico 24h"). */
export const MAX_KEYS: (keyof Omit<SeriesPoint, 't'>)[] = ['cpu', 'iowait', 'steal', 'load1', 'mem_used_pct', 'swap_pct', 'disk_util', 'net_rx', 'net_tx', 'psi_cpu', 'psi_io', 'psi_mem'];
