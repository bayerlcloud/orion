import { describe, it, expect } from 'vitest';
import { healthScore } from '../web/src/pages/dashHealth';

describe('healthScore', () => {
  it('máquina folgada tira 10', () => {
    const h = healthScore({ cpu: { pct: 10, iowait: 0, steal: 0 }, mem: { pct: 20, swap_pct: 0 }, disk: { util_pct: 3, fs: { pct: 10 } }, load: { l1: 0.3 }, host: { vcpus: 6 } });
    expect(h.score).toBe(10); expect(h.grade).toBe('ok'); expect(h.motivos).toContain('tudo dentro do normal');
  });
  it('iowait alto derruba muito a nota', () => {
    const h = healthScore({ cpu: { pct: 20, iowait: 40 }, host: { vcpus: 6 } });
    expect(h.score).toBeLessThan(8); expect(h.motivos.some(m => /iowait/.test(m))).toBe(true);
  });
  it('vários problemas juntos → crítico', () => {
    const h = healthScore({ cpu: { pct: 95, iowait: 30 }, mem: { pct: 96, swap_pct: 80 }, disk: { util_pct: 95, fs: { pct: 95 } }, load: { l1: 20 }, host: { vcpus: 4 }, units: [{ active: 'failed' }, { active: 'failed' }] });
    expect(h.score).toBeLessThanOrEqual(3); expect(h.grade).toBe('ruim');
  });
  it('serviço em falha entra nos motivos', () => {
    const h = healthScore({ units: [{ active: 'failed' }], host: { vcpus: 2 } });
    expect(h.motivos.some(m => /falha/.test(m))).toBe(true);
  });
  it('sem amostra → 0 e sem dados', () => {
    expect(healthScore(null).score).toBe(0);
    expect(healthScore(undefined).label).toBe('sem dados');
  });
  it('nota fica entre 0 e 10 e com 1 casa', () => {
    const h = healthScore({ cpu: { pct: 80, iowait: 10 }, host: { vcpus: 6 } });
    expect(h.score).toBeGreaterThanOrEqual(0); expect(h.score).toBeLessThanOrEqual(10);
  });
});
