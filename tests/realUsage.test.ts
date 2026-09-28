import { describe, it, expect } from 'vitest';
import { parseUsageResponse } from '../server/claude/realUsage';

describe('parseUsageResponse', () => {
  it('converte utilization de 0-1 (como a API manda) para 0-100 (como o resto do Orion espera)', () => {
    const r = parseUsageResponse({ subscription_type: 'max', five_hour: { utilization: 0.79, resets_at: '2026-09-28T15:00:00Z' } });
    expect(r).toEqual({ subscription_type: 'max', rate_limits: { five_hour: { utilization: 79, resets_at: '2026-09-28T15:00:00Z' } } });
  });
  it('junta as janelas presentes (5h, 7d, 7d sonnet) e ignora as ausentes', () => {
    const r = parseUsageResponse({
      subscription_type: 'max',
      five_hour: { utilization: 0.1, resets_at: 'a' },
      seven_day: { utilization: 0.2, resets_at: 'b' },
      seven_day_sonnet: { utilization: 0.3, resets_at: 'c' },
    });
    expect(Object.keys(r!.rate_limits)).toEqual(['five_hour', 'seven_day', 'seven_day_sonnet']);
  });
  it('monta model_scoped (ex.: "Fable") com o display_name que a API mandar', () => {
    const r = parseUsageResponse({ subscription_type: 'max', model_scoped: [{ display_name: 'Fable', utilization: 0.04, resets_at: 'x' }] });
    expect(r!.rate_limits.model_scoped).toEqual([{ display_name: 'Fable', utilization: 4, resets_at: 'x' }]);
  });
  it('janela com utilization null é pulada, igual à extensão real', () => {
    const r = parseUsageResponse({ subscription_type: 'max', five_hour: { utilization: null, resets_at: 'a' }, seven_day: { utilization: 0.5, resets_at: 'b' } });
    expect(r!.rate_limits.five_hour).toBeUndefined();
    expect(r!.rate_limits.seven_day).toEqual({ utilization: 50, resets_at: 'b' });
  });
  it('sem nenhuma janela utilizável, devolve null (nunca um objeto vazio disfarçado de dado real)', () => {
    expect(parseUsageResponse({ subscription_type: 'max' })).toBeNull();
    expect(parseUsageResponse({ subscription_type: 'max', five_hour: { utilization: null, resets_at: null } })).toBeNull();
  });
  it('subscription_type ausente vira null, não undefined (schema estável pro resto do código)', () => {
    const r = parseUsageResponse({ five_hour: { utilization: 0.5, resets_at: 'a' } });
    expect(r!.subscription_type).toBeNull();
  });
});
