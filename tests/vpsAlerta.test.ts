import { describe, it, expect } from 'vitest';
import { shouldAlert } from '../scripts/vpsRemoteSampler.js';

describe('shouldAlert', () => {
  it('não alerta quando disco e swap estão normais', () => {
    expect(shouldAlert({ disk: 50, swap: 10 }, null, Date.now())).toEqual({ alerta: false, motivo: null });
  });
  it('alerta na primeira vez que disco > 85 ou swap > 50', () => {
    expect(shouldAlert({ disk: 90, swap: 10 }, null, Date.now())).toMatchObject({ alerta: true, motivo: expect.stringContaining('disco 90%') });
    expect(shouldAlert({ disk: 10, swap: 60 }, null, Date.now())).toMatchObject({ alerta: true, motivo: expect.stringContaining('swap 60%') });
  });
  it('não repete antes do cooldown (1h default), repete depois', () => {
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    expect(shouldAlert({ disk: 90, swap: 10 }, new Date(t0).toISOString(), t0 + 30 * 60_000)).toEqual({ alerta: false, motivo: null });
    expect(shouldAlert({ disk: 90, swap: 10 }, new Date(t0).toISOString(), t0 + 61 * 60_000).alerta).toBe(true);
  });
});
