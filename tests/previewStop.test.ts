import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const W = path.resolve('deploy/preview/orion-preview-stop');
const run = (...a: string[]) => spawnSync('/bin/sh', [W, ...a], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ORION_PREVIEW_STOP_DRY: '1' } });

describe('orion-preview-stop (wrapper do sudoers)', () => {
  it('recusa mais de um argumento, nome com espaço, barra ou vazio', () => {
    for (const args of [[], ['a', 'caddy'], ['x caddy'], ['../x'], ['a/b'], ['A.b'], ['-x'], ['x;id']]) {
      expect(run(...args).status, JSON.stringify(args)).toBe(2);
    }
  });
  it('aceita nome de instância válido e só para preview-vite@<nome>', () => {
    const r = run('lais.ralab');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('/usr/bin/systemctl stop preview-vite@lais.ralab.service');
  });
});
