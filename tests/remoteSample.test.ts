import { describe, it, expect } from 'vitest';
import { parseRemoteOutput, collectRemoteSample, REMOTE_HOSTS } from '../server/dash/remoteSample.js';

const MEM = 'MemTotal:       12288000 kB\nMemFree:         2048000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n';
const DF = 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1   290000000 12000000 270000000       5% /\n';
const DOCKER = '{"Names":"n8n","Status":"Up 3 days","State":"running","Image":"n8nio/n8n"}\n';
const COMBINED = `${MEM}---DF---\n${DF}---DOCKER---\n${DOCKER}`;

describe('remoteSample', () => {
  it('REMOTE_HOSTS tem os 3 hosts remotos com os IPs de docs/infra.json', () => {
    expect(REMOTE_HOSTS).toEqual([
      { label: 'c1', ip: '86.48.28.10' }, { label: 'c2', ip: '212.47.70.170' }, { label: 'hostinger', ip: '72.61.135.82' },
    ]);
  });

  it('parseRemoteOutput separa as 3 seções pelos delimitadores', () => {
    const r = parseRemoteOutput(COMBINED);
    expect(r.mem).toContain('MemTotal');
    expect(r.df).toContain('/dev/sda1');
    expect(r.docker).toContain('n8n');
  });

  it('collectRemoteSample parseia mem/fs/docker quando o ssh responde bem', async () => {
    const s = await collectRemoteSample({ label: 'c1', ip: '86.48.28.10' }, async () => ({ code: 0, out: COMBINED }));
    expect(s.host).toBe('c1');
    expect(s.mem?.swap_pct).toBe(50);
    expect(s.fs?.pct).toBe(5);
    expect(s.docker).toEqual([{ name: 'n8n', status: 'Up 3 days', state: 'running', image: 'n8nio/n8n' }]);
    expect(s.errors).toEqual([]);
  });

  it('collectRemoteSample marca erros sem lançar quando o ssh falha', async () => {
    const s = await collectRemoteSample({ label: 'c2', ip: '212.47.70.170' }, async () => ({ code: 1, out: '' }));
    expect(s.mem).toBeNull();
    expect(s.fs).toBeNull();
    expect(s.docker).toBeNull();
    expect(s.errors).toEqual(['ssh', '/proc/meminfo', 'df /']);
  });
});
