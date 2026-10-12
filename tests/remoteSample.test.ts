import { describe, it, expect } from 'vitest';
import { parseRemoteOutput, collectRemoteSample, REMOTE_HOSTS } from '../server/dash/remoteSample.js';

const HOSTNAME = 'c1';
const KERNEL = '5.15.0-generic';
const UPTIME = '123456.78 987654.32';
const NPROC = '4';
const LOAD = '0.50 0.40 0.30 2/300 12345';
const PROCS = '180';
const ROUTE = 'Iface\tDestination\tGateway\nens3\t00000000\t0102030A\n';
const STAT1 = 'cpu  1000 0 500 8000 100 0 0 0 0 0\n';
const NET1 = 'Inter-|   Receive                                                |  Transmit\n' +
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
  '  ens3: 1000000   1000    0    0    0     0          0         0  2000000    2000    0    0    0     0       0          0\n';
const STAT2 = 'cpu  1100 0 550 8050 110 0 0 0 0 0\n';
const NET2 = 'Inter-|   Receive                                                |  Transmit\n' +
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
  '  ens3: 1102400   1010    0    0    0     0          0         0  2204800    2010    0    0    0     0       0          0\n';
const MEM = 'MemTotal:       12288000 kB\nMemFree:         2048000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n';
const DF = 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1   290000000 12000000 270000000       5% /\n';
const DOCKER = '{"Names":"n8n","Status":"Up 3 days","State":"running","Image":"n8nio/n8n"}\n';

const COMBINED = `${HOSTNAME}\n---KERNEL---\n${KERNEL}\n---UPTIME---\n${UPTIME}\n---NPROC---\n${NPROC}\n` +
  `---LOAD---\n${LOAD}\n---PROCS---\n${PROCS}\n---ROUTE---\n${ROUTE}---STAT1---\n${STAT1}---NET1---\n${NET1}` +
  `---STAT2---\n${STAT2}---NET2---\n${NET2}---MEM---\n${MEM}---DF---\n${DF}---DOCKER---\n${DOCKER}`;

describe('remoteSample', () => {
  it('REMOTE_HOSTS tem os 3 hosts remotos com os IPs de docs/infra.json', () => {
    expect(REMOTE_HOSTS).toEqual([
      { label: 'c1', ip: '86.48.28.10' }, { label: 'c2', ip: '212.47.70.170' }, { label: 'hostinger', ip: '72.61.135.82' },
    ]);
  });

  it('parseRemoteOutput separa todas as seções pelos delimitadores', () => {
    const r = parseRemoteOutput(COMBINED);
    expect(r.hostname).toContain('c1');
    expect(r.kernel).toContain('5.15.0-generic');
    expect(r.mem).toContain('MemTotal');
    expect(r.df).toContain('/dev/sda1');
    expect(r.docker).toContain('n8n');
  });

  it('collectRemoteSample parseia host/cpu/load/net/procs/mem/fs/docker quando o ssh responde bem', async () => {
    const s = await collectRemoteSample({ label: 'c1', ip: '86.48.28.10' }, async () => ({ code: 0, out: COMBINED }));
    expect(s.host).toBe('c1');
    expect(s.info).toEqual({ hostname: 'c1', kernel: '5.15.0-generic', uptime_s: 123457, vcpus: 4 });
    expect(s.load).toMatchObject({ l1: 0.5, l5: 0.4, l15: 0.3, running: 2, threads: 300 });
    expect(s.procsCount).toBe(180);
    expect(s.cpu).toMatchObject({ pct: expect.any(Number), iowait: expect.any(Number), steal: expect.any(Number) });
    expect(s.net).toMatchObject({ iface: 'ens3', rx_kbs: expect.any(Number), tx_kbs: expect.any(Number) });
    expect(s.mem?.swap_pct).toBe(50);
    expect(s.fs?.pct).toBe(5);
    expect(s.docker).toEqual([{ name: 'n8n', status: 'Up 3 days', state: 'running', image: 'n8nio/n8n' }]);
    expect(s.errors).toEqual([]);
  });

  it('collectRemoteSample marca erros sem lançar quando o ssh falha', async () => {
    const s = await collectRemoteSample({ label: 'c2', ip: '212.47.70.170' }, async () => ({ code: 1, out: '' }));
    expect(s.info).toBeNull();
    expect(s.load).toBeNull();
    expect(s.cpu).toBeNull();
    expect(s.net).toBeNull();
    expect(s.procsCount).toBeNull();
    expect(s.mem).toBeNull();
    expect(s.fs).toBeNull();
    expect(s.docker).toBeNull();
    expect(s.errors).toEqual(['ssh', 'host', '/proc/loadavg', 'procs', '/proc/stat', '/proc/meminfo', 'df /']);
  });
});
