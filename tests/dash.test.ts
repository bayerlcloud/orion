import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseProcStat, cpuDelta, parseLoadavg, parseMeminfo, parsePressure, parseDiskstats, diskDelta,
  rootDeviceFromMounts, baseDisk, pickDiskDevice, parseNetDev, parseDefaultRouteIface, pickIface, netDelta,
  parseDf, parseFileNr, parseSsSummary, parseSockstat, parsePidStat, parsePidStatus, cmdlineName, parsePasswd,
  topProcesses, parseDockerPs, parseSystemctlUnits,
} from '../server/dash/parse.js';
import { aggregateMinute } from '../server/dash/series.js';
import { Sampler } from '../server/dash/sampler.js';
import { sparkPath, fmtBytes, fmtKBs, ago, agoIso, unitStatus, activityFor, type UserActivity } from '../web/src/pages/dashUtils';

const STAT_A = `cpu  1000 10 500 8000 200 0 50 40 0 0
cpu0 500 5 250 4000 100 0 25 20 0 0
cpu1 500 5 250 4000 100 0 25 20 0 0
intr 12345 0 0
ctxt 99999
btime 1700000000
`;
const STAT_B = `cpu  1300 10 600 8400 300 0 60 60 0 0
cpu0 650 5 300 4200 150 0 30 30 0 0
cpu1 650 5 300 4200 150 0 30 30 0 0
`;

const MEMINFO = `MemTotal:       12288000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
SwapCached:            0 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
SReclaimable:     256000 kB
`;

const DISKSTATS = ` 259       0 nvme0n1 1000 20 80000 500 2000 40 160000 900 0 1500 1400 0 0 0 0 0 0
 259       1 nvme0n1p1 100 2 8000 50 200 4 16000 90 0 150 140 0 0 0 0 0 0
   7       0 loop0 10 0 80 1 0 0 0 0 0 1 1 0 0 0 0 0 0
`;
const DISKSTATS2 = ` 259       0 nvme0n1 1100 20 100480 600 2200 40 201200 1000 2 2500 2400 0 0 0 0 0 0
 259       1 nvme0n1p1 100 2 8000 50 200 4 16000 90 0 150 140 0 0 0 0 0 0
`;

const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 50 0 0 0 0 0 0 5000 50 0 0 0 0 0 0
  eth0: 1048576 1000 0 0 0 0 0 0 524288 800 0 0 0 0 0 0
docker0: 99999999 9 0 0 0 0 0 0 99999999 9 0 0 0 0 0 0
`;
const NETDEV2 = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 50 0 0 0 0 0 0 5000 50 0 0 0 0 0 0
  eth0: 2097152 2000 0 0 0 0 0 0 786432 1200 0 0 0 0 0 0
`;
const ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	00000000	0100A8C0	0003	0	0	100	00000000	0	0	0
eth0	0000A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
`;

const SS = `Total: 512
TCP:   45 (estab 12, closed 20, orphaned 1, timewait 15)

Transport Total     IP        IPv6
RAW	  0         0         0
UDP	  8         6         2
TCP	  25        21        4
INET	  33        27        6
FRAG	  0         0         0
`;

const PID_STAT = '4242 (postgres: main (x)) S 1 4242 4242 0 -1 4194560 12345 0 0 0 150 50 0 0 20 0 5 0 1234 987654321 2560 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
const PID_STATUS = `Name:	postgres
Umask:	0077
State:	S (sleeping)
Pid:	4242
Uid:	108	108	108	108
Gid:	112	112	112	112
VmRSS:	   10240 kB
Threads:	5
`;

describe('parseProcStat / cpuDelta', () => {
  it('lê a linha cpu agregada', () => {
    const t = parseProcStat(STAT_A)!;
    expect(t).toMatchObject({ user: 1000, nice: 10, system: 500, idle: 8000, iowait: 200, irq: 0, softirq: 50, steal: 40 });
  });
  it('calcula cpu%, iowait% e steal% pelos deltas', () => {
    const d = cpuDelta(parseProcStat(STAT_A), parseProcStat(STAT_B))!;
    // deltas: user 300, system 100, idle 400, iowait 100, softirq 10, steal 20 → total 930
    expect(d.cpu).toBeCloseTo(410 / 930 * 100, 0);
    expect(d.iowait).toBeCloseTo(100 / 930 * 100, 0);
    expect(d.steal).toBeCloseTo(20 / 930 * 100, 0);
    expect(d.cpu + d.iowait + d.steal).toBeLessThanOrEqual(100.2);
  });
  it('devolve null sem delta ou com contador regredido', () => {
    expect(cpuDelta(parseProcStat(STAT_A), parseProcStat(STAT_A))).toBeNull();
    expect(cpuDelta(parseProcStat(STAT_B), parseProcStat(STAT_A))).toBeNull();
    expect(cpuDelta(null, parseProcStat(STAT_A))).toBeNull();
  });
  it('não quebra com entrada inválida', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('cpu x y z')).toBeNull();
    expect(parseProcStat('intr 1 2 3')).toBeNull();
    expect(parseProcStat(null as unknown as string)).toBeNull();
    expect(parseProcStat(42 as unknown as string)).toBeNull();
  });
});

describe('parseLoadavg', () => {
  it('lê 1/5/15, rodando e threads', () => {
    expect(parseLoadavg('0.52 0.58 0.59 2/1234 56789\n')).toEqual({ l1: 0.52, l5: 0.58, l15: 0.59, running: 2, threads: 1234 });
  });
  it('tolera formato parcial e lixo', () => {
    expect(parseLoadavg('1.5 2.5 3.5')).toMatchObject({ l1: 1.5, l5: 2.5, l15: 3.5, running: 0 });
    expect(parseLoadavg('a b c')).toBeNull();
    expect(parseLoadavg('')).toBeNull();
    expect(parseLoadavg(undefined as unknown as string)).toBeNull();
  });
});

describe('parseMeminfo', () => {
  it('converte kB para bytes e calcula usado/percentual/swap', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(m.total).toBe(12288000 * 1024);
    expect(m.available).toBe(8192000 * 1024);
    expect(m.used).toBe((12288000 - 8192000) * 1024);
    expect(m.pct).toBeCloseTo(33.3, 0);
    expect(m.swap_total).toBe(2097152 * 1024);
    expect(m.swap_used).toBe(1048576 * 1024);
    expect(m.swap_pct).toBe(50);
  });
  it('estima MemAvailable quando falta (kernels antigos)', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n')!;
    expect(m.available).toBe(400 * 1024);
  });
  it('null sem MemTotal ou com lixo', () => {
    expect(parseMeminfo('MemFree: 5 kB')).toBeNull();
    expect(parseMeminfo('###')).toBeNull();
    expect(parseMeminfo('')).toBeNull();
  });
});

describe('parsePressure', () => {
  it('lê some/full avg10 e avg60', () => {
    const p = parsePressure('some avg10=1.25 avg60=0.80 avg300=0.30 total=123456\nfull avg10=0.10 avg60=0.05 avg300=0.01 total=999\n')!;
    expect(p.some).toEqual({ avg10: 1.25, avg60: 0.8, avg300: 0.3 });
    expect(p.full).toEqual({ avg10: 0.1, avg60: 0.05, avg300: 0.01 });
  });
  it('cpu só tem some; ausência e lixo dão null', () => {
    expect(parsePressure('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')!.full).toBeNull();
    expect(parsePressure('')).toBeNull();
    expect(parsePressure('some avg10=abc')).toBeNull();
    expect(parsePressure(null as unknown as string)).toBeNull();
  });
});

describe('diskstats', () => {
  it('lê contadores por dispositivo e calcula KB/s e util% pelo delta', () => {
    const a = parseDiskstats(DISKSTATS), b = parseDiskstats(DISKSTATS2);
    expect(a.get('nvme0n1')).toMatchObject({ reads: 1000, sectors_read: 80000, writes: 2000, sectors_written: 160000, io_ms: 1500 });
    const d = diskDelta(a.get('nvme0n1')!, b.get('nvme0n1')!, 10)!;
    expect(d.read_kbs).toBeCloseTo(20480 * 512 / 1024 / 10, 1); // 1024 KB/s
    expect(d.write_kbs).toBeCloseTo(41200 * 512 / 1024 / 10, 1);
    expect(d.util_pct).toBe(10); // 1000 ms em 10 s
  });
  it('escolhe o disco-base da raiz e resolve nomes de partição', () => {
    const stats = parseDiskstats(DISKSTATS);
    expect(rootDeviceFromMounts('sysfs /sys sysfs rw 0 0\n/dev/nvme0n1p1 / ext4 rw,relatime 0 0\n/dev/sdb1 /data ext4 rw 0 0\n')).toBe('/dev/nvme0n1p1');
    expect(rootDeviceFromMounts('overlay / overlay rw 0 0')).toBeNull();
    expect(baseDisk('nvme0n1p1')).toBe('nvme0n1');
    expect(baseDisk('sda3')).toBe('sda');
    expect(baseDisk('vda')).toBe('vda');
    expect(baseDisk('dm-0')).toBe('dm-0');
    expect(pickDiskDevice('/dev/nvme0n1p1', stats)).toBe('nvme0n1');
    expect(pickDiskDevice(null, stats)).toBe('nvme0n1'); // ignora loop0
    expect(pickDiskDevice('/dev/sdz9', new Map())).toBeNull();
  });
  it('não quebra com linhas curtas, lixo ou delta sem tempo', () => {
    expect(parseDiskstats('8 0 sda 1 2\nlixo\n').size).toBe(0);
    expect(parseDiskstats(undefined as unknown as string).size).toBe(0);
    const a = parseDiskstats(DISKSTATS).get('nvme0n1')!;
    expect(diskDelta(a, a, 0)).toBeNull();
    expect(diskDelta(null, a, 10)).toBeNull();
    expect(diskDelta(parseDiskstats(DISKSTATS2).get('nvme0n1')!, a, 10)).toEqual({ read_kbs: 0, write_kbs: 0, util_pct: 0 });
  });
});

describe('net/dev e route', () => {
  it('lê bytes rx/tx por interface e calcula KB/s', () => {
    const a = parseNetDev(NETDEV), b = parseNetDev(NETDEV2);
    expect(a.get('eth0')).toEqual({ rx_bytes: 1048576, rx_packets: 1000, tx_bytes: 524288, tx_packets: 800 });
    expect(netDelta(a.get('eth0')!, b.get('eth0')!, 10)).toEqual({ rx_kbs: 102.4, tx_kbs: 25.6 });
  });
  it('prefere a interface da rota padrão, senão a de maior tráfego não virtual', () => {
    const a = parseNetDev(NETDEV);
    expect(parseDefaultRouteIface(ROUTE)).toBe('eth0');
    expect(pickIface('eth0', a)).toBe('eth0');
    expect(pickIface('wlan9', a)).toBe('eth0'); // docker0 tem mais bytes mas é virtual
    expect(pickIface(null, new Map([['lo', a.get('lo')!]]))).toBeNull();
    expect(parseDefaultRouteIface('')).toBeNull();
  });
  it('tolera lixo', () => {
    expect(parseNetDev('nada aqui').size).toBe(0);
    expect(parseNetDev(null as unknown as string).size).toBe(0);
    expect(netDelta(null, null, 10)).toBeNull();
  });
});

describe('df, file-nr, ss -s, sockstat', () => {
  it('df -kP', () => {
    const d = parseDf('Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/nvme0n1p1   290000000 12000000 270000000       5% /\n')!;
    expect(d).toEqual({ total: 290000000 * 1024, used: 12000000 * 1024, avail: 270000000 * 1024, pct: 5 });
    expect(parseDf('Filesystem\n')).toBeNull();
    expect(parseDf('')).toBeNull();
  });
  it('file-nr', () => {
    expect(parseFileNr('1856\t0\t9223372036854775807\n')).toEqual({ open: 1856, max: 9223372036854775807 });
    expect(parseFileNr('x')).toBeNull();
    expect(parseFileNr('')).toBeNull();
  });
  it('ss -s tolerante', () => {
    expect(parseSsSummary(SS)).toEqual({ total: 512, tcp: 45, estab: 12, timewait: 15, orphaned: 1, closed: 20 });
    expect(parseSsSummary('TCP: 3 (established 2, timewait 1)')).toMatchObject({ tcp: 3, estab: 2, timewait: 1 });
    expect(parseSsSummary('Total: 7\n')).toMatchObject({ total: 7, estab: null });
    expect(parseSsSummary('ss: command not found')).toBeNull();
    expect(parseSsSummary('')).toBeNull();
  });
  it('/proc/net/sockstat', () => {
    expect(parseSockstat('sockets: used 300\nTCP: inuse 12 orphan 0 tw 15 alloc 30 mem 5\nUDP: inuse 4\n')).toEqual({ estab: 12, timewait: 15, orphaned: 0 });
    expect(parseSockstat('UDP: inuse 4')).toBeNull();
  });
});

describe('processos', () => {
  it('lê /proc/<pid>/stat com comm contendo espaços e parênteses', () => {
    const p = parsePidStat(PID_STAT)!;
    expect(p).toMatchObject({ pid: 4242, comm: 'postgres: main (x)', state: 'S', ticks: 200, threads: 5, starttime: 1234, rss_pages: 2560 });
    expect(parsePidStat('4242 sem parenteses')).toBeNull();
    expect(parsePidStat('1 (a) S 1 2')).toBeNull();
    expect(parsePidStat('')).toBeNull();
  });
  it('status, cmdline e passwd', () => {
    expect(parsePidStatus(PID_STATUS)).toEqual({ name: 'postgres', uid: 108, vm_rss: 10240 * 1024, threads: 5 });
    expect(parsePidStatus('')).toBeNull();
    expect(cmdlineName('/usr/lib/postgresql/16/bin/postgres\0-D\0/var/lib/postgresql/16/main\0', 'postgres')).toBe('postgres -D /var/lib/postgresql/16/main');
    expect(cmdlineName('', 'kworker/0:1')).toBe('[kworker/0:1]');
    expect(cmdlineName(null, '')).toBe('?');
    expect(cmdlineName('/bin/x\0' + 'a'.repeat(100), 'x').length).toBe(48);
    expect(parsePasswd('root:x:0:0:root:/root:/bin/bash\ndanilo:x:1000:1000::/home/danilo:/bin/bash\nquebrada\n').get(1000)).toBe('danilo');
  });
  it('top por CPU usa delta de ticks; top por RSS usa páginas', () => {
    const a = new Map([[1, parsePidStat('1 (init) S 0 1 1 0 -1 0 0 0 0 0 100 100 0 0 20 0 1 0 5 0 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')!],
      [2, parsePidStat('2 (busy) R 1 2 2 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 0 5000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')!]]);
    const b = new Map([[1, parsePidStat('1 (init) S 0 1 1 0 -1 0 0 0 0 0 110 100 0 0 20 0 1 0 5 0 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')!],
      [2, parsePidStat('2 (busy) R 1 2 2 0 -1 0 0 0 0 0 400 100 0 0 20 0 1 0 5 0 5000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')!],
      [3, parsePidStat('3 (novo) R 1 3 3 0 -1 0 0 0 0 0 999 0 0 0 20 0 1 0 9 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')!]]);
    const t = topProcesses({ cur: b, prev: a, seconds: 10, clkTck: 100 });
    expect(t.top_cpu[0]).toMatchObject({ pid: 2, cpu: 50 }); // 500 ticks / 100 Hz / 10 s
    expect(t.top_cpu.map(p => p.pid)).toEqual([2, 1]); // pid 3 é novo: sem delta, fica de fora
    expect(t.top_mem[0]).toMatchObject({ pid: 2, rss: 5000 * 4096 });
    expect(topProcesses({ cur: new Map(), prev: new Map(), seconds: 10 })).toEqual({ top_cpu: [], top_mem: [] });
  });
});

describe('docker ps e systemctl', () => {
  it('docker ps --format json, linha por linha, ignorando lixo', () => {
    const out = parseDockerPs('{"ID":"abc","Names":"n8n","Status":"Up 3 days","State":"running","Image":"n8nio/n8n"}\nlixo\n{"Names":"caddy","Status":"Exited (1) 2 h ago","State":"exited"}\n{ inválido\n');
    expect(out).toEqual([
      { name: 'caddy', status: 'Exited (1) 2 h ago', state: 'exited', image: '' },
      { name: 'n8n', status: 'Up 3 days', state: 'running', image: 'n8nio/n8n' },
    ]);
    expect(parseDockerPs('')).toEqual([]);
    expect(parseDockerPs(undefined as unknown as string)).toEqual([]);
  });
  it('systemctl list-units filtrado pelo regex de interesse', () => {
    const txt = `  caddy.service       loaded active running Caddy
● fail2ban.service    loaded failed failed  Fail2Ban Service
  cron.service        loaded active running Regular background program processing daemon
  orion-central.service loaded active running Orion Central
  ssh.socket          loaded active listening OpenBSD Secure Shell server socket
  docker.service      loaded inactive dead   Docker Application Container Engine
`;
    const u = parseSystemctlUnits(txt);
    expect(u.map(x => x.unit)).toEqual(['caddy.service', 'docker.service', 'fail2ban.service', 'orion-central.service', 'ssh.socket']);
    expect(u.find(x => x.unit === 'fail2ban.service')).toMatchObject({ active: 'failed', sub: 'failed', description: 'Fail2Ban Service' });
    expect(parseSystemctlUnits('Failed to connect to bus')).toEqual([]);
    expect(parseSystemctlUnits('')).toEqual([]);
  });
});

describe('aggregateMinute', () => {
  it('média e máximo por chave, ignorando nulls', () => {
    const base = { t: 0, cpu: null, iowait: null, steal: null, load1: null, load5: null, load15: null, mem_used_pct: null, swap_pct: null, disk_util: null, disk_read: null, disk_write: null, fs_pct: null, net_rx: null, net_tx: null, psi_cpu: null, psi_io: null, psi_mem: null, files_open: null, tcp_estab: null, tcp_timewait: null };
    const agg = aggregateMinute([{ ...base, t: 1, cpu: 10, load1: 1 }, { ...base, t: 2, cpu: 30, load1: null }, { ...base, t: 3, cpu: 50, load1: 3 }]);
    expect(agg.n).toBe(3);
    expect(agg.cpu).toBe(30);
    expect(agg.cpu_max).toBe(50);
    expect(agg.load1).toBe(2);
    expect(agg.mem_used_pct).toBeNull();
    expect(agg.t_from).toBe(1);
    expect(agg.t_to).toBe(3);
    expect(aggregateMinute([]).n).toBe(0);
    expect(aggregateMinute(null as unknown as never).n).toBe(0);
  });
});

describe('dashUtils', () => {
  it('sparkPath gera linha e área, com lacunas em null', () => {
    const s = sparkPath([0, 50, 100], 100, 40, { max: 100 });
    expect(s.line).toBe('M0 39L50 20L100 1');
    expect(s.area.startsWith('M0 40L0 39')).toBe(true);
    expect(sparkPath([1, null, 2], 100, 10).line.split('M').length - 1).toBe(2);
    expect(sparkPath([], 100, 10).line).toBe('');
    expect(sparkPath([null, null], 100, 10).line).toBe('');
    expect(sparkPath([0.5, 1], 100, 10, { minMax: 5 }).max).toBe(5);
  });
  it('formatadores pt-BR tolerantes', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(12.5 * 1024 ** 3)).toBe('12,5 GB');
    expect(fmtKBs(2048)).toBe('2 MB/s');
    expect(ago(5000)).toBe('há 5 s');
    expect(ago(125000)).toBe('há 2 min');
    expect(unitStatus('failed', 'failed')).toMatchObject({ failed: true });
    expect(unitStatus('active', 'running').label).toBe('active');
    expect(unitStatus(undefined, undefined).label).toBe('—');
  });
  it('activityFor acha por id, cai pro nome se faltar id, e some direito quando não tem nada', () => {
    const lista: UserActivity[] = [
      { id: 1, name: 'Guilherme', last_login: '2026-09-26T12:00:00Z', commands_7d: 3 },
      { id: 2, name: 'Lais', last_login: null, commands_7d: 0 },
    ];
    expect(activityFor(lista, 1, 'outro nome qualquer')).toMatchObject({ id: 1, commands_7d: 3 });
    expect(activityFor(lista, undefined, 'Lais')).toMatchObject({ id: 2, last_login: null });
    expect(activityFor(lista, 99, 'ninguém com esse nome')).toBeNull();
    expect(activityFor([], 1, 'Guilherme')).toBeNull();
    expect(activityFor(null, 1, 'Guilherme')).toBeNull();
  });
  it('agoIso some com login nulo e formata relativo quando tem data', () => {
    expect(agoIso(null)).toBe('—');
    const agora = Date.parse('2026-09-27T12:00:00Z');
    expect(agoIso('2026-09-26T12:00:00Z', agora)).toBe('há 24 h');
  });
});

describe('Sampler com /proc de mentira', () => {
  let dir = '';
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('produz uma amostra completa com deltas sem executar comandos', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orion-dash-'));
    const w = async (rel: string, txt: string) => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), txt); };
    await w('stat', STAT_A); await w('loadavg', '0.5 0.6 0.7 1/200 999\n'); await w('meminfo', MEMINFO);
    await w('pressure/cpu', 'some avg10=0.50 avg60=0.20 avg300=0.10 total=1\n');
    await w('pressure/io', 'some avg10=1.00 avg60=0.50 avg300=0.10 total=1\nfull avg10=0.20 avg60=0.10 avg300=0.00 total=1\n');
    await w('diskstats', DISKSTATS); await w('net/dev', NETDEV); await w('net/route', ROUTE);
    await w('mounts', '/dev/nvme0n1p1 / ext4 rw 0 0\n'); await w('sys/fs/file-nr', '1856 0 9223372036854775807\n');
    await w('net/sockstat', 'TCP: inuse 12 orphan 0 tw 15 alloc 30 mem 5\n');
    await w('4242/stat', PID_STAT); await w('4242/status', PID_STATUS); await w('4242/cmdline', '/usr/bin/postgres\0-D\0/x\0');

    const s = new Sampler(null, { procRoot: dir, exec: false, tickMs: 60_000 });
    await s.start();
    s.stop();
    expect(s.latest()).toBeNull();

    await w('stat', STAT_B); await w('diskstats', DISKSTATS2); await w('net/dev', NETDEV2);
    await w('4242/stat', PID_STAT.replace(' 150 50 ', ' 250 50 '));
    const sample = (await s.tick())!;
    expect(sample).not.toBeNull();
    expect(sample.cpu!.pct).toBeCloseTo(44.1, 0);
    expect(sample.cpu!.iowait).toBeCloseTo(10.8, 0);
    expect(sample.load).toMatchObject({ l1: 0.5, l5: 0.6, l15: 0.7 });
    expect(sample.mem!.pct).toBeCloseTo(33.3, 0);
    expect(sample.psi.cpu).toEqual({ some10: 0.5, some60: 0.2 });
    expect(sample.psi.io).toEqual({ some10: 1, some60: 0.5, full10: 0.2, full60: 0.1 });
    expect(sample.psi.mem).toBeNull(); // arquivo ausente
    expect(sample.disk.device).toBe('nvme0n1');
    expect(sample.disk.util_pct).not.toBeNull();
    expect(sample.net.iface).toBe('eth0');
    expect(sample.net.rx_kbs).toBeGreaterThan(0);
    expect(sample.files).toEqual({ open: 1856, max: 9223372036854775807 });
    expect(sample.tcp).toMatchObject({ estab: 12, timewait: 15 });
    expect(sample.procs.count).toBe(1);
    expect(sample.procs.top_mem[0]).toMatchObject({ pid: 4242, name: 'postgres -D /x', rss: 10240 * 1024 });
    expect(sample.procs.top_cpu[0]?.pid).toBe(4242);
    expect(sample.docker).toBeNull();
    expect(sample.units).toBeNull();
    expect(s.series().length).toBe(1);
    expect(s.series()[0]).toMatchObject({ cpu: sample.cpu!.pct, load1: 0.5, tcp_estab: 12 });
  });

  it('não lança quando /proc não existe', async () => {
    const s = new Sampler(null, { procRoot: path.join(os.tmpdir(), 'orion-dash-inexistente-' + Date.now()), exec: false, tickMs: 60_000 });
    await s.start();
    s.stop();
    const sample = await s.tick();
    expect(sample).not.toBeNull();
    expect(sample!.cpu).toBeNull();
    expect(sample!.errors).toContain('/proc/stat');
  });
});
