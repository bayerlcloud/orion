// Parsers puros (sem I/O) dos arquivos de /proc e das saídas de comandos usados pelo Dash.
// Regra: nunca lançar; entrada inválida devolve null (ou lista vazia).

import type { ProcRow } from './types.js';

const SECTOR = 512;

function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function isText(v: unknown): v is string { return typeof v === 'string'; }
export function round1(x: number): number { return Math.round(x * 10) / 10; }
export function clampPct(x: number): number { return round1(Math.min(100, Math.max(0, x))); }

// ---------- /proc/stat ----------

export type CpuTimes = { user: number; nice: number; system: number; idle: number; iowait: number; irq: number; softirq: number; steal: number };

export function parseProcStat(text: string): CpuTimes | null {
  if (!isText(text)) return null;
  const line = text.split('\n').find(l => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.slice(0, 4).some(x => !Number.isFinite(x))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f.map(x => (Number.isFinite(x) ? x : 0));
  return { user, nice, system, idle, iowait, irq, softirq, steal };
}

export function cpuTotal(t: CpuTimes): number {
  return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
}

/** Percentuais a partir de dois snapshots. cpu exclui idle, iowait e steal (os três somam 100 com idle). */
export function cpuDelta(prev: CpuTimes | null, cur: CpuTimes | null): { cpu: number; iowait: number; steal: number } | null {
  if (!prev || !cur) return null;
  const total = cpuTotal(cur) - cpuTotal(prev);
  if (!(total > 0)) return null;
  const idle = Math.max(0, cur.idle - prev.idle);
  const iowait = Math.max(0, cur.iowait - prev.iowait);
  const steal = Math.max(0, cur.steal - prev.steal);
  const busy = Math.max(0, total - idle - iowait - steal);
  return { cpu: clampPct(busy / total * 100), iowait: clampPct(iowait / total * 100), steal: clampPct(steal / total * 100) };
}

// ---------- /proc/loadavg ----------

export function parseLoadavg(text: string): { l1: number; l5: number; l15: number; running: number; threads: number } | null {
  if (!isText(text)) return null;
  const f = text.trim().split(/\s+/);
  if (f.length < 3) return null;
  const [l1, l5, l15] = f.slice(0, 3).map(Number);
  if (![l1, l5, l15].every(Number.isFinite)) return null;
  const [running, threads] = (f[3] ?? '0/0').split('/').map(Number);
  return { l1, l5, l15, running: n(running), threads: n(threads) };
}

// ---------- /proc/meminfo ----------

export type MemInfo = { total: number; free: number; available: number; used: number; pct: number; buffers: number; cached: number; swap_total: number; swap_free: number; swap_used: number; swap_pct: number };

export function parseMeminfo(text: string): MemInfo | null {
  if (!isText(text)) return null;
  const kb: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)(?:\s+kB)?/);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const total = (kb.MemTotal ?? 0) * 1024;
  if (!(total > 0)) return null;
  const free = (kb.MemFree ?? 0) * 1024;
  const buffers = (kb.Buffers ?? 0) * 1024;
  const cached = ((kb.Cached ?? 0) + (kb.SReclaimable ?? 0)) * 1024;
  const available = kb.MemAvailable !== undefined ? kb.MemAvailable * 1024 : Math.min(total, free + buffers + cached);
  const used = Math.max(0, total - available);
  const swap_total = (kb.SwapTotal ?? 0) * 1024;
  const swap_free = (kb.SwapFree ?? 0) * 1024;
  const swap_used = Math.max(0, swap_total - swap_free);
  return {
    total, free, available, used, pct: clampPct(used / total * 100), buffers, cached,
    swap_total, swap_free, swap_used, swap_pct: swap_total > 0 ? clampPct(swap_used / swap_total * 100) : 0,
  };
}

// ---------- /proc/pressure/{cpu,io,memory} ----------

export type Pressure = { some: { avg10: number; avg60: number; avg300: number }; full: { avg10: number; avg60: number; avg300: number } | null };

function pressureLine(line: string): { avg10: number; avg60: number; avg300: number } | null {
  const g = (k: string) => { const m = line.match(new RegExp(`\\b${k}=([\\d.]+)`)); return m ? Number(m[1]) : NaN; };
  const avg10 = g('avg10'), avg60 = g('avg60'), avg300 = g('avg300');
  if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) return null;
  return { avg10, avg60, avg300: Number.isFinite(avg300) ? avg300 : 0 };
}

export function parsePressure(text: string): Pressure | null {
  if (!isText(text)) return null;
  const lines = text.split('\n');
  const some = lines.find(l => l.startsWith('some'));
  const full = lines.find(l => l.startsWith('full'));
  const s = some ? pressureLine(some) : null;
  if (!s) return null;
  return { some: s, full: full ? pressureLine(full) : null };
}

// ---------- /proc/diskstats ----------

export type DiskCounters = { device: string; reads: number; sectors_read: number; writes: number; sectors_written: number; in_flight: number; io_ms: number };

export function parseDiskstats(text: string): Map<string, DiskCounters> {
  const out = new Map<string, DiskCounters>();
  if (!isText(text)) return out;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 13 || !f[2]) continue;
    const nums = f.slice(3, 13).map(Number);
    if (nums.some(x => !Number.isFinite(x))) continue;
    out.set(f[2], { device: f[2], reads: nums[0], sectors_read: nums[2], writes: nums[4], sectors_written: nums[6], in_flight: nums[8], io_ms: nums[9] });
  }
  return out;
}

export function diskDelta(prev: DiskCounters | null, cur: DiskCounters | null, seconds: number): { read_kbs: number; write_kbs: number; util_pct: number } | null {
  if (!prev || !cur || !(seconds > 0)) return null;
  const rd = Math.max(0, cur.sectors_read - prev.sectors_read) * SECTOR / 1024 / seconds;
  const wr = Math.max(0, cur.sectors_written - prev.sectors_written) * SECTOR / 1024 / seconds;
  const util = Math.max(0, cur.io_ms - prev.io_ms) / (seconds * 1000) * 100;
  return { read_kbs: round1(rd), write_kbs: round1(wr), util_pct: clampPct(util) };
}

/** Dispositivo montado em "/" segundo /proc/mounts (ex.: "/dev/sda1"); null se não achar ou se for overlay/rootfs. */
export function rootDeviceFromMounts(text: string): string | null {
  if (!isText(text)) return null;
  let dev: string | null = null;
  for (const line of text.split('\n')) {
    const f = line.split(/\s+/);
    if (f[1] === '/' && f[0] && f[0].startsWith('/dev/')) dev = f[0];
  }
  return dev;
}

/** "sda1" → "sda"; "nvme0n1p2" → "nvme0n1"; "vda" → "vda"; "mmcblk0p1" → "mmcblk0"; "dm-0" → "dm-0". */
export function baseDisk(name: string): string {
  if (!isText(name)) return '';
  if (/^(nvme\d+n\d+|mmcblk\d+|loop\d+)p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  if (/^(sd|vd|xvd|hd)[a-z]+\d+$/.test(name)) return name.replace(/\d+$/, '');
  return name;
}

const DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+|dm-\d+|md\d+)$/;

/** Escolhe o dispositivo para medir I/O: o disco-base da raiz se existir em diskstats, senão o primeiro disco "real" com mais I/O. */
export function pickDiskDevice(mounted: string | null, stats: Map<string, DiskCounters>): string | null {
  if (mounted) {
    const name = mounted.replace(/^\/dev\//, '');
    for (const c of [baseDisk(name), name]) if (c && stats.has(c)) return c;
  }
  let best: DiskCounters | null = null;
  for (const d of stats.values()) {
    if (!DISK_RE.test(d.device)) continue;
    if (!best || d.reads + d.writes > best.reads + best.writes) best = d;
  }
  return best?.device ?? null;
}

// ---------- /proc/net/dev e /proc/net/route ----------

export type NetCounters = { rx_bytes: number; rx_packets: number; tx_bytes: number; tx_packets: number };

export function parseNetDev(text: string): Map<string, NetCounters> {
  const out = new Map<string, NetCounters>();
  if (!isText(text)) return out;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^\s:]+):\s*(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 10 || f.slice(0, 10).some(x => !Number.isFinite(x))) continue;
    out.set(m[1], { rx_bytes: f[0], rx_packets: f[1], tx_bytes: f[8], tx_packets: f[9] });
  }
  return out;
}

/** Interface da rota padrão (Destination 00000000) em /proc/net/route. */
export function parseDefaultRouteIface(text: string): string | null {
  if (!isText(text)) return null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 2 && f[1] === '00000000' && f[0]) return f[0];
  }
  return null;
}

export function pickIface(preferred: string | null, counters: Map<string, NetCounters>): string | null {
  if (preferred && counters.has(preferred)) return preferred;
  let best: string | null = null, bestBytes = -1;
  for (const [name, c] of counters) {
    if (name === 'lo' || /^(veth|br-|docker|virbr|tap|tun)/.test(name)) continue;
    const b = c.rx_bytes + c.tx_bytes;
    if (b > bestBytes) { best = name; bestBytes = b; }
  }
  if (best) return best;
  for (const name of counters.keys()) if (name !== 'lo') return name;
  return null;
}

export function netDelta(prev: NetCounters | null, cur: NetCounters | null, seconds: number): { rx_kbs: number; tx_kbs: number } | null {
  if (!prev || !cur || !(seconds > 0)) return null;
  return {
    rx_kbs: round1(Math.max(0, cur.rx_bytes - prev.rx_bytes) / 1024 / seconds),
    tx_kbs: round1(Math.max(0, cur.tx_bytes - prev.tx_bytes) / 1024 / seconds),
  };
}

// ---------- df -kP / ----------

export function parseDf(text: string): { total: number; used: number; avail: number; pct: number } | null {
  if (!isText(text)) return null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const total = Number(f[1]) * 1024, used = Number(f[2]) * 1024, avail = Number(f[3]) * 1024;
    if (![total, used, avail].every(Number.isFinite) || !(total > 0)) continue;
    const pctStr = Number(String(f[4]).replace('%', ''));
    const pct = Number.isFinite(pctStr) ? pctStr : clampPct(used / (used + avail) * 100);
    return { total, used, avail, pct };
  }
  return null;
}

// ---------- /proc/sys/fs/file-nr ----------

export function parseFileNr(text: string): { open: number; max: number } | null {
  if (!isText(text)) return null;
  const f = text.trim().split(/\s+/).map(Number);
  if (f.length < 3 || !Number.isFinite(f[0]) || !Number.isFinite(f[2])) return null;
  return { open: f[0], max: f[2] };
}

// ---------- ss -s e /proc/net/sockstat ----------

export type TcpSummary = { total: number | null; tcp: number | null; estab: number | null; timewait: number | null; orphaned: number | null; closed: number | null };

export function parseSsSummary(text: string): TcpSummary | null {
  if (!isText(text)) return null;
  const g = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  const out: TcpSummary = {
    total: g(/^Total:\s+(\d+)/m),
    tcp: g(/^TCP:\s+(\d+)/m),
    estab: g(/\bestab(?:lished)?\s+(\d+)/i),
    timewait: g(/\btimewait\s+(\d+)/i),
    orphaned: g(/\borphaned\s+(\d+)/i),
    closed: g(/\bclosed\s+(\d+)/i),
  };
  if (Object.values(out).every(v => v === null)) return null;
  return out;
}

/** "TCP: inuse 12 orphan 0 tw 15 alloc 30 mem 5" */
export function parseSockstat(text: string): { estab: number | null; timewait: number | null; orphaned: number | null } | null {
  if (!isText(text)) return null;
  const line = text.split('\n').find(l => l.startsWith('TCP:'));
  if (!line) return null;
  const g = (k: string) => { const m = line.match(new RegExp(`\\b${k}\\s+(\\d+)`)); return m ? Number(m[1]) : null; };
  return { estab: g('inuse'), timewait: g('tw'), orphaned: g('orphan') };
}

// ---------- /proc/<pid>/stat, status, cmdline ----------

export type PidStat = { pid: number; comm: string; state: string; ticks: number; threads: number; starttime: number; rss_pages: number };

export function parsePidStat(text: string): PidStat | null {
  if (!isText(text)) return null;
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0]=state(3) … utime(14)=rest[11] stime(15)=rest[12] num_threads(20)=rest[17] starttime(22)=rest[19] rss(24)=rest[21]
  if (!Number.isFinite(pid) || rest.length < 22) return null;
  const utime = Number(rest[11]), stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { pid, comm, state: rest[0] ?? '?', ticks: utime + stime, threads: n(rest[17]), starttime: n(rest[19]), rss_pages: n(rest[21]) };
}

export function parsePidStatus(text: string): { name: string | null; uid: number | null; vm_rss: number | null; threads: number | null } | null {
  if (!isText(text)) return null;
  const g = (k: string) => { const m = text.match(new RegExp(`^${k}:\\s+(.+)$`, 'm')); return m ? m[1].trim() : null; };
  const name = g('Name');
  const uidRaw = g('Uid');
  const rss = g('VmRSS');
  const thr = g('Threads');
  if (name === null && uidRaw === null && rss === null) return null;
  return {
    name,
    uid: uidRaw ? n(uidRaw.split(/\s+/)[0]) : null,
    vm_rss: rss ? n(rss.split(/\s+/)[0]) * 1024 : null,
    threads: thr ? n(thr) : null,
  };
}

/** /proc/<pid>/cmdline (NUL-separado) → "prog arg1 arg2" com basename do programa, truncado. */
export function cmdlineName(raw: string | null, comm: string, max = 48): string {
  const parts = (raw ?? '').split('\0').filter(Boolean);
  let s: string;
  if (parts.length === 0) s = comm ? `[${comm}]` : '?';
  else {
    const prog = parts[0].split('/').pop() || parts[0];
    s = [prog, ...parts.slice(1)].join(' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** /etc/passwd → mapa uid → nome. */
export function parsePasswd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!isText(text)) return out;
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length >= 3 && f[0] && Number.isFinite(Number(f[2]))) out.set(Number(f[2]), f[0]);
  }
  return out;
}

export type TopInput = { cur: Map<number, PidStat>; prev: Map<number, PidStat>; seconds: number; clkTck?: number; pageSize?: number; limit?: number };

/** Top N por CPU (delta de ticks) e por RSS. cpu é % de um núcleo; null quando o pid não existia na amostra anterior. */
export function topProcesses(input: TopInput): { top_cpu: (PidStat & { cpu: number | null; rss: number })[]; top_mem: (PidStat & { cpu: number | null; rss: number })[] } {
  const clk = input.clkTck && input.clkTck > 0 ? input.clkTck : 100;
  const page = input.pageSize && input.pageSize > 0 ? input.pageSize : 4096;
  const limit = input.limit ?? 8;
  const rows = [...input.cur.values()].map(p => {
    const old = input.prev.get(p.pid);
    // % de um núcleo (pode passar de 100 com várias threads); teto generoso só contra contadores absurdos.
    const cpu = old && old.starttime === p.starttime && input.seconds > 0
      ? round1(Math.min(6400, Math.max(0, p.ticks - old.ticks) / clk / input.seconds * 100))
      : null;
    return { ...p, cpu, rss: p.rss_pages * page };
  });
  const top_cpu = rows.filter(r => r.cpu !== null && r.cpu > 0).sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, limit);
  const top_mem = [...rows].sort((a, b) => b.rss - a.rss).slice(0, limit);
  return { top_cpu, top_mem };
}

// ---------- docker ps --format '{{json .}}' ----------

export function parseDockerPs(text: string): { name: string; status: string; state: string; image: string }[] {
  const out: { name: string; status: string; state: string; image: string }[] = [];
  if (!isText(text)) return out;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const name = String(j.Names ?? j.Name ?? j.ID ?? '').trim();
      if (!name) continue;
      out.push({ name, status: String(j.Status ?? ''), state: String(j.State ?? ''), image: String(j.Image ?? '') });
    } catch { /* linha inválida: ignora */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- systemctl list-units --plain --no-legend ----------

export const UNIT_RE = /orion|kanna|caddy|docker|postgres|fail2ban|ufw|ssh/i;

export function parseSystemctlUnits(text: string, filter: RegExp = UNIT_RE): { unit: string; load: string; active: string; sub: string; description: string }[] {
  const out: { unit: string; load: string; active: string; sub: string; description: string }[] = [];
  if (!isText(text)) return out;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s●*✗x]+/, '').trim();
    if (!line) continue;
    const f = line.split(/\s+/);
    if (f.length < 4 || !/\.[a-z]+$/.test(f[0])) continue;
    const unit = f[0];
    if (filter && !filter.test(unit)) continue;
    out.push({ unit, load: f[1], active: f[2], sub: f[3], description: f.slice(4).join(' ') });
  }
  return out.sort((a, b) => a.unit.localeCompare(b.unit));
}

export function toProcRow(p: PidStat & { cpu: number | null; rss: number }, name: string, user: string | null): ProcRow {
  return { pid: p.pid, name, user, state: p.state, threads: p.threads, cpu: p.cpu, rss: p.rss };
}
