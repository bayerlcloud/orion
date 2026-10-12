import { describe, it, expect } from 'vitest';
import { shouldAlert, pontoRemoto } from '../server/dash/remoteAlerta.js';
import { collectRemoteSample } from '../server/dash/remoteSample.js';

describe('shouldAlert', () => {
  it('não alerta quando disco e swap estão normais', () => {
    expect(shouldAlert({ disk: 50, swap: 10 }, false)).toEqual({ alerta: false, emAlerta: false, motivo: null });
  });
  it('alerta na primeira vez que disco > 85 ou swap > 50 (transição normal→alerta)', () => {
    expect(shouldAlert({ disk: 90, swap: 10 }, false)).toMatchObject({ alerta: true, emAlerta: true, motivo: expect.stringContaining('disco 90%') });
    expect(shouldAlert({ disk: 10, swap: 60 }, false)).toMatchObject({ alerta: true, emAlerta: true, motivo: expect.stringContaining('swap 60%') });
  });
  it('enquanto já está em alerta, não repete', () => {
    expect(shouldAlert({ disk: 90, swap: 10 }, true)).toEqual({ alerta: false, emAlerta: true, motivo: null });
  });
  it('depois de normalizar (emAlerta=false) e cruzar de novo, alerta de novo', () => {
    // normalizou: a chamada anterior já teria emAlerta=false; nova leitura cruza o limite outra vez
    expect(shouldAlert({ disk: 90, swap: 10 }, false)).toMatchObject({ alerta: true, emAlerta: true });
  });
});

describe('pontoRemoto', () => {
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

  it('monta o contrato exato que web/src/pages/Dash.tsx lê, a partir de collectRemoteSample', async () => {
    const sample = await collectRemoteSample({ label: 'c1', ip: '86.48.28.10' }, async () => ({ code: 0, out: COMBINED }));
    const ponto = pontoRemoto(sample);
    expect(Object.keys(ponto).sort()).toEqual(
      ['host', 'cpu', 'load', 'net', 'procs', 'docker', 'errors', 'fs_pct', 'mem_used_pct', 'swap_pct', 't'].sort(),
    );
    expect(typeof ponto.t).toBe('number');
    expect(ponto.host).toEqual({ hostname: 'c1', kernel: '5.15.0-generic', uptime_s: 123457, vcpus: 4 });
    expect(ponto.load).toMatchObject({ l1: 0.5, l5: 0.4, l15: 0.3 });
    expect(ponto.procs).toEqual({ count: 180 });
    expect(ponto.net).toMatchObject({ iface: 'ens3' });
    expect(ponto.swap_pct).toBe(50);
    expect(ponto.fs_pct).toBe(5);
    expect(ponto.docker).toEqual([{ name: 'n8n', status: 'Up 3 days', state: 'running', image: 'n8nio/n8n' }]);
    expect(ponto.errors).toEqual([]);
  });

  it('campos ficam null quando a amostra falha, sem lançar', async () => {
    const sample = await collectRemoteSample({ label: 'c2', ip: '212.47.70.170' }, async () => ({ code: 1, out: '' }));
    const ponto = pontoRemoto(sample);
    expect(ponto.host).toBeNull();
    expect(ponto.cpu).toBeNull();
    expect(ponto.load).toBeNull();
    expect(ponto.net).toBeNull();
    expect(ponto.procs).toBeNull();
    expect(ponto.mem_used_pct).toBeNull();
    expect(ponto.swap_pct).toBeNull();
    expect(ponto.fs_pct).toBeNull();
    expect(ponto.docker).toBeNull();
    expect(ponto.errors).toEqual(['ssh', 'host', '/proc/loadavg', 'procs', '/proc/stat', '/proc/meminfo', 'df /']);
  });
});
