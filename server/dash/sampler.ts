// Coletor do Dash: a cada 10 s lê /proc e comandos baratos, guarda 360 amostras em memória
// (1 h) e grava uma agregação por minuto em dash_samples (retém 7 dias). Toda sonda tolera falha.

import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir, realpath, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import * as P from './parse.js';
import { aggregateMinute, toPoint } from './series.js';
import { ensureDashSamplesTable, insertDashSample } from './schema.js';
import type { ProcRow, Sample, SeriesPoint } from './types.js';

const execFile = promisify(execFileCb);

export const TICK_MS = 10_000;
export const RING_SIZE = 360;
export const WRITE_EVERY_MS = 60_000;
export const HOST_LABEL = 'c3';
export const HOST_IP = '217.76.55.249';

export type Log = { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
export type SamplerOptions = { procRoot?: string; tickMs?: number; log?: Log; label?: string; ip?: string; exec?: boolean };

type Prev = { at: number; cpu: P.CpuTimes | null; disk: P.DiskCounters | null; net: P.NetCounters | null; procs: Map<number, P.PidStat> };

async function read(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function run(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  try {
    const { stdout } = await execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    return stdout;
  } catch { return null; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

export class Sampler {
  private ring: Sample[] = [];
  private points: SeriesPoint[] = [];
  private minute: SeriesPoint[] = [];
  private subs = new Set<(s: Sample) => void>();
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private prev: Prev | null = null;
  private diskDevice: string | null = null;
  private iface: string | null = null;
  private lastWrite = 0;
  private tableOk = false;
  private clkTck = 100;
  private pageSize = 4096;
  private passwd = new Map<number, string>();
  private passwdAt = 0;
  private readonly procRoot: string;
  private readonly tickMs: number;
  private readonly log: Log;
  private readonly exec: boolean;

  constructor(private readonly pool: Pool | null, private readonly opts: SamplerOptions = {}) {
    this.procRoot = opts.procRoot ?? '/proc';
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.log = opts.log ?? { info: () => {}, warn: () => {} };
    this.exec = opts.exec ?? true;
  }

  latest(): Sample | null { return this.ring[this.ring.length - 1] ?? null; }

  series(n = RING_SIZE): SeriesPoint[] {
    const k = Math.max(1, Math.min(RING_SIZE, Math.floor(n) || RING_SIZE));
    return this.points.slice(-k);
  }

  subscribe(fn: (s: Sample) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  /** Idempotente. Cria a tabela (tolerante), lê constantes, faz uma leitura de base e agenda o tick. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.ensureTable();
    if (this.exec) {
      const clk = Number((await run('getconf', ['CLK_TCK'], 2000))?.trim());
      if (clk > 0) this.clkTck = clk;
      const page = Number((await run('getconf', ['PAGESIZE'], 2000))?.trim());
      if (page > 0) this.pageSize = page;
    }
    await this.prime().catch(e => this.log.warn({ err: String(e) }, 'dash: prime falhou'));
    this.lastWrite = Date.now(); // primeira gravação só depois de um minuto inteiro de amostras
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
    // primeira amostra completa logo após a base (para o painel não abrir vazio)
    this.firstTimer = setTimeout(() => { this.firstTimer = null; void this.tick(); }, Math.min(1500, this.tickMs));
    this.firstTimer.unref?.();
    this.log.info({ procRoot: this.procRoot, tickMs: this.tickMs }, 'dash: coletor iniciado');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
    this.started = false;
  }

  private async ensureTable(): Promise<void> {
    if (!this.pool || this.tableOk) return;
    this.tableOk = await ensureDashSamplesTable(this.pool, this.log);
  }

  /** Só os contadores, para a primeira amostra já ter deltas. */
  private async prime(): Promise<void> {
    const at = Date.now();
    const [stat, diskstats, netdev, mounts, route] = await Promise.all([
      read(`${this.procRoot}/stat`), read(`${this.procRoot}/diskstats`), read(`${this.procRoot}/net/dev`),
      read(`${this.procRoot}/mounts`), read(`${this.procRoot}/net/route`),
    ]);
    const disks = P.parseDiskstats(diskstats ?? '');
    this.diskDevice = await this.resolveDisk(mounts, disks);
    const nets = P.parseNetDev(netdev ?? '');
    this.iface = P.pickIface(P.parseDefaultRouteIface(route ?? ''), nets);
    const procs = await this.scanProcs();
    this.prev = {
      at, cpu: P.parseProcStat(stat ?? ''),
      disk: this.diskDevice ? disks.get(this.diskDevice) ?? null : null,
      net: this.iface ? nets.get(this.iface) ?? null : null,
      procs,
    };
  }

  private async resolveDisk(mounts: string | null, disks: Map<string, P.DiskCounters>): Promise<string | null> {
    let mounted = P.rootDeviceFromMounts(mounts ?? '');
    if (mounted && (mounted.startsWith('/dev/mapper/') || mounted.includes('/by-'))) {
      try { mounted = await realpath(mounted); } catch { /* fica como está */ }
    }
    return P.pickDiskDevice(mounted, disks);
  }

  private async scanProcs(): Promise<Map<number, P.PidStat>> {
    const out = new Map<number, P.PidStat>();
    let names: string[] = [];
    try { names = await readdir(this.procRoot); } catch { return out; }
    const pids = names.filter(x => /^\d+$/.test(x));
    const stats = await mapLimit(pids, 48, async pid => P.parsePidStat(await read(`${this.procRoot}/${pid}/stat`) ?? ''));
    for (const s of stats) if (s) out.set(s.pid, s);
    return out;
  }

  private async userOf(uid: number | null): Promise<string | null> {
    if (uid === null) return null;
    if (Date.now() - this.passwdAt > 10 * 60_000) {
      this.passwd = P.parsePasswd(await read('/etc/passwd') ?? '');
      this.passwdAt = Date.now();
    }
    return this.passwd.get(uid) ?? String(uid);
  }

  private async enrich(rows: (P.PidStat & { cpu: number | null; rss: number })[]): Promise<ProcRow[]> {
    return mapLimit(rows, 8, async p => {
      const [cmdline, status] = await Promise.all([read(`${this.procRoot}/${p.pid}/cmdline`), read(`${this.procRoot}/${p.pid}/status`)]);
      const st = P.parsePidStatus(status ?? '');
      const rss = st?.vm_rss ?? p.rss;
      return P.toProcRow({ ...p, rss }, P.cmdlineName(cmdline, p.comm), await this.userOf(st?.uid ?? null));
    });
  }

  /** Uma amostra completa. Nunca lança; erros de sonda vão em `errors`. */
  async tick(): Promise<Sample | null> {
    if (this.running) return null;
    this.running = true;
    const errors: string[] = [];
    try {
      const at = Date.now();
      const pr = this.procRoot;
      const [stat, loadavg, meminfo, psiCpu, psiIo, psiMem, diskstats, netdev, fileNr, sockstat] = await Promise.all([
        read(`${pr}/stat`), read(`${pr}/loadavg`), read(`${pr}/meminfo`),
        read(`${pr}/pressure/cpu`), read(`${pr}/pressure/io`), read(`${pr}/pressure/memory`),
        read(`${pr}/diskstats`), read(`${pr}/net/dev`), read(`${pr}/sys/fs/file-nr`), read(`${pr}/net/sockstat`),
      ]);
      const [ssOut, dockerOut, unitsOut, procs] = await Promise.all([
        this.exec ? run('ss', ['-s'], 3000) : null,
        this.exec ? run('docker', ['ps', '--format', '{{json .}}'], 4000) : null,
        this.exec ? run('systemctl', ['list-units', '--all', '--plain', '--no-legend', '--no-pager', '--type=service,socket'], 3000) : null,
        this.scanProcs(),
      ]);

      const cpuNow = P.parseProcStat(stat ?? '');
      if (!cpuNow) errors.push('/proc/stat');
      const load = P.parseLoadavg(loadavg ?? '');
      if (!load) errors.push('/proc/loadavg');
      const mem = P.parseMeminfo(meminfo ?? '');
      if (!mem) errors.push('/proc/meminfo');

      const disks = P.parseDiskstats(diskstats ?? '');
      if (!this.diskDevice || !disks.has(this.diskDevice)) this.diskDevice = await this.resolveDisk(await read(`${pr}/mounts`), disks);
      const diskNow = this.diskDevice ? disks.get(this.diskDevice) ?? null : null;
      const nets = P.parseNetDev(netdev ?? '');
      if (!this.iface || !nets.has(this.iface)) this.iface = P.pickIface(P.parseDefaultRouteIface(await read(`${pr}/net/route`) ?? ''), nets);
      const netNow = this.iface ? nets.get(this.iface) ?? null : null;

      const seconds = this.prev ? (at - this.prev.at) / 1000 : 0;
      const cpu = cpuNow && this.prev ? P.cpuDelta(this.prev.cpu, cpuNow) : null;
      const dio = this.prev ? P.diskDelta(this.prev.disk, diskNow, seconds) : null;
      const nio = this.prev ? P.netDelta(this.prev.net, netNow, seconds) : null;

      let fs: Sample['disk']['fs'] = null;
      try {
        const s = await statfs('/');
        const total = Number(s.blocks) * Number(s.bsize), avail = Number(s.bavail) * Number(s.bsize), used = (Number(s.blocks) - Number(s.bfree)) * Number(s.bsize);
        if (total > 0) fs = { total, used, avail, pct: P.clampPct(used / (used + avail || 1) * 100) };
      } catch { /* tenta df */ }
      if (!fs && this.exec) fs = P.parseDf(await run('df', ['-kP', '/'], 3000) ?? '');
      if (!fs) errors.push('df /');

      const ss = P.parseSsSummary(ssOut ?? '');
      const sk = P.parseSockstat(sockstat ?? '');
      const tcp = ss || sk ? {
        total: ss?.total ?? null,
        estab: ss?.estab ?? sk?.estab ?? null,
        timewait: ss?.timewait ?? sk?.timewait ?? null,
        orphaned: ss?.orphaned ?? sk?.orphaned ?? null,
      } : null;

      const top = P.topProcesses({ cur: procs, prev: this.prev?.procs ?? new Map(), seconds, clkTck: this.clkTck, pageSize: this.pageSize, limit: 8 });
      const [top_cpu, top_mem] = await Promise.all([this.enrich(top.top_cpu), this.enrich(top.top_mem)]);

      const psi = {
        cpu: (() => { const p = P.parsePressure(psiCpu ?? ''); return p ? { some10: p.some.avg10, some60: p.some.avg60 } : null; })(),
        io: (() => { const p = P.parsePressure(psiIo ?? ''); return p ? { some10: p.some.avg10, some60: p.some.avg60, full10: p.full?.avg10 ?? null, full60: p.full?.avg60 ?? null } : null; })(),
        mem: (() => { const p = P.parsePressure(psiMem ?? ''); return p ? { some10: p.some.avg10, some60: p.some.avg60, full10: p.full?.avg10 ?? null, full60: p.full?.avg60 ?? null } : null; })(),
      };

      const sample: Sample = {
        ts: new Date(at).toISOString(), t: at,
        host: {
          hostname: os.hostname(), kernel: os.release(), uptime_s: Math.round(os.uptime()),
          vcpus: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
          label: this.opts.label ?? HOST_LABEL, ip: this.opts.ip ?? HOST_IP,
        },
        cpu: cpu ? { pct: cpu.cpu, iowait: cpu.iowait, steal: cpu.steal } : null,
        load,
        mem: mem ? { total: mem.total, used: mem.used, available: mem.available, pct: mem.pct, buffers: mem.buffers, cached: mem.cached, swap_total: mem.swap_total, swap_used: mem.swap_used, swap_pct: mem.swap_pct } : null,
        psi,
        disk: { device: this.diskDevice, read_kbs: dio?.read_kbs ?? null, write_kbs: dio?.write_kbs ?? null, util_pct: dio?.util_pct ?? null, fs },
        net: { iface: this.iface, rx_kbs: nio?.rx_kbs ?? null, tx_kbs: nio?.tx_kbs ?? null },
        files: P.parseFileNr(fileNr ?? ''),
        tcp,
        procs: { top_cpu, top_mem, count: procs.size },
        docker: dockerOut === null ? null : P.parseDockerPs(dockerOut),
        units: unitsOut === null ? null : P.parseSystemctlUnits(unitsOut),
        errors,
      };

      this.prev = { at, cpu: cpuNow, disk: diskNow, net: netNow, procs };
      this.push(sample);
      if (at - this.lastWrite >= WRITE_EVERY_MS) { this.lastWrite = at; await this.persist(); }
      return sample;
    } catch (e) {
      this.log.warn({ err: String(e) }, 'dash: tick falhou');
      return null;
    } finally {
      this.running = false;
    }
  }

  private push(sample: Sample): void {
    this.ring.push(sample);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    const pt = toPoint(sample);
    this.points.push(pt);
    if (this.points.length > RING_SIZE) this.points.shift();
    this.minute.push(pt);
    for (const fn of this.subs) { try { fn(sample); } catch { /* assinante quebrado não derruba o coletor */ } }
  }

  private async persist(): Promise<void> {
    if (!this.pool) return;
    const agg = aggregateMinute(this.minute);
    this.minute = [];
    if (agg.n === 0) return;
    try {
      await this.ensureTable();
      if (!this.tableOk) return;
      await insertDashSample(this.pool, this.opts.label ?? HOST_LABEL, agg, this.log);
    } catch (e) {
      this.log.warn({ err: String(e) }, 'dash: não gravou dash_samples');
    }
  }
}
