// Coleta remota de mem/disco/docker por SSH, para as VPS fora da c3 (c1, c2, hostinger).
// Nunca lança: falha de ssh ou de parser vira entrada em `errors`.

import { runSsh } from '../ssh.js';
import {
  parseMeminfo, parseDf, parseDockerPs, parseLoadavg, parseProcStat, cpuDelta,
  parseNetDev, parseDefaultRouteIface, pickIface, netDelta,
} from './parse.js';

export { REMOTE_HOSTS } from './remoteHosts.js';

// Dois snapshots de /proc/stat e /proc/net/dev com 1s de intervalo (sleep 1), pra tirar
// deltas de CPU e rede num SSH só, igual à coleta local em sampler.ts. docker ps tem timeout
// próprio (20s) pra não travar o resto da coleta quando a VPS tem muito container (ex. hostinger).
export const REMOTE_CMD =
  "hostname; echo '---KERNEL---'; uname -r; echo '---UPTIME---'; cat /proc/uptime; " +
  "echo '---NPROC---'; nproc; echo '---LOAD---'; cat /proc/loadavg; " +
  "echo '---PROCS---'; ls /proc | grep -c '^[0-9]\\+$'; echo '---ROUTE---'; cat /proc/net/route; " +
  "echo '---STAT1---'; cat /proc/stat; echo '---NET1---'; cat /proc/net/dev; sleep 1; " +
  "echo '---STAT2---'; cat /proc/stat; echo '---NET2---'; cat /proc/net/dev; " +
  "echo '---MEM---'; cat /proc/meminfo; echo '---DF---'; df -kP /; " +
  "echo '---DOCKER---'; timeout 20 docker ps --format '{{json .}}'";

const SECTIONS = [
  'hostname', 'kernel', 'uptime', 'nproc', 'load', 'procs', 'route',
  'stat1', 'net1', 'stat2', 'net2', 'mem', 'df', 'docker',
] as const;
const DELIMS = [
  '---KERNEL---', '---UPTIME---', '---NPROC---', '---LOAD---', '---PROCS---', '---ROUTE---',
  '---STAT1---', '---NET1---', '---STAT2---', '---NET2---', '---MEM---', '---DF---', '---DOCKER---',
] as const;

export type RemoteSections = Record<(typeof SECTIONS)[number], string>;

/** Separa a saída combinada de REMOTE_CMD nas seções, pelos delimitadores únicos. */
export function parseRemoteOutput(raw: string): RemoteSections {
  const out = {} as RemoteSections;
  let rest = raw;
  for (let i = 0; i < DELIMS.length; i++) {
    const idx = rest.indexOf(DELIMS[i]);
    if (idx < 0) { out[SECTIONS[i]] = rest; rest = ''; continue; }
    out[SECTIONS[i]] = rest.slice(0, idx);
    rest = rest.slice(idx + DELIMS[i].length);
  }
  out[SECTIONS[SECTIONS.length - 1]] = rest;
  return out;
}

function numOrNull(raw: string): number | null {
  const t = raw.trim().split(/\s+/)[0];
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type RemoteSample = {
  host: string;
  ts: string;
  info: { hostname: string; kernel: string; uptime_s: number; vcpus: number } | null;
  cpu: { pct: number; iowait: number; steal: number } | null;
  load: ReturnType<typeof parseLoadavg>;
  net: { iface: string | null; rx_kbs: number | null; tx_kbs: number | null } | null;
  procsCount: number | null;
  mem: ReturnType<typeof parseMeminfo> | null;
  fs: ReturnType<typeof parseDf> | null;
  docker: ReturnType<typeof parseDockerPs> | null;
  errors: string[];
};

export async function collectRemoteSample(
  host: { label: string; ip: string },
  ssh: (ip: string, cmd: string, timeoutMs?: number) => Promise<{ code: number; out: string }> = runSsh,
): Promise<RemoteSample> {
  const errors: string[] = [];
  const { code, out } = await ssh(host.ip, REMOTE_CMD, 30_000);
  if (code !== 0) errors.push('ssh');

  const s = parseRemoteOutput(out);

  const hostname = s.hostname.trim();
  const kernel = s.kernel.trim();
  const uptime_s = numOrNull(s.uptime);
  const vcpus = numOrNull(s.nproc);
  const info = hostname && kernel && uptime_s !== null && vcpus !== null
    ? { hostname, kernel, uptime_s: Math.round(uptime_s), vcpus } : null;
  if (!info) errors.push('host');

  const load = parseLoadavg(s.load);
  if (!load) errors.push('/proc/loadavg');

  const procsCount = numOrNull(s.procs);
  if (procsCount === null) errors.push('procs');

  const cpu1 = parseProcStat(s.stat1);
  const cpu2 = parseProcStat(s.stat2);
  const cpuD = cpuDelta(cpu1, cpu2);
  if (!cpuD) errors.push('/proc/stat');
  const cpu = cpuD ? { pct: cpuD.cpu, iowait: cpuD.iowait, steal: cpuD.steal } : null;

  const nets1 = parseNetDev(s.net1);
  const nets2 = parseNetDev(s.net2);
  const iface = pickIface(parseDefaultRouteIface(s.route), nets2);
  const netIo = iface ? netDelta(nets1.get(iface) ?? null, nets2.get(iface) ?? null, 1) : null;
  const net = iface ? { iface, rx_kbs: netIo?.rx_kbs ?? null, tx_kbs: netIo?.tx_kbs ?? null } : null;

  const mem = parseMeminfo(s.mem);
  if (!mem) errors.push('/proc/meminfo');

  const fs = parseDf(s.df);
  if (!fs) errors.push('df /');

  const docker = code === 0 ? parseDockerPs(s.docker) : null;

  return { host: host.label, ts: new Date().toISOString(), info, cpu, load, net, procsCount, mem, fs, docker, errors };
}
