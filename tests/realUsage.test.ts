import { describe, it, expect } from 'vitest';
import { parseUsageResponse } from '../server/claude/realUsage';

// Formato real de GET /api/oauth/usage, capturado ao vivo em produção em 2026-09-28 (primeiro login
// bem sucedido via claude auth login) — utilization já em escala 0-100, sem model_scoped/
// subscription_type; o limite específico de modelo vem em limits[] com kind "weekly_scoped".
const RESPOSTA_REAL = {
  five_hour: { utilization: 12.0, resets_at: '2026-09-28T16:59:59.796403+00:00' },
  seven_day: { utilization: 13.0, resets_at: '2026-10-03T01:59:59.796425+00:00' },
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 12, resets_at: '2026-09-28T16:59:59.796403+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 13, resets_at: '2026-10-03T01:59:59.796425+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 4, resets_at: '2026-10-03T01:59:59.796660+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
};

describe('parseUsageResponse', () => {
  it('usa utilization como já vem, 0-100 — NÃO multiplica por 100 (regressão: dobrava pra 100% sempre)', () => {
    const r = parseUsageResponse(RESPOSTA_REAL);
    expect(r!.rate_limits.five_hour).toEqual({ utilization: 12, resets_at: '2026-09-28T16:59:59.796403+00:00' });
    expect(r!.rate_limits.seven_day).toEqual({ utilization: 13, resets_at: '2026-10-03T01:59:59.796425+00:00' });
  });
  it('monta a barra de modelo (ex.: "Fable") a partir de limits[kind=weekly_scoped], não de model_scoped (não existe na resposta real)', () => {
    const r = parseUsageResponse(RESPOSTA_REAL);
    expect(r!.rate_limits.model_scoped).toEqual([{ display_name: 'Fable', utilization: 4, resets_at: '2026-10-03T01:59:59.796660+00:00' }]);
  });
  it('ignora entradas de limits[] sem kind weekly_scoped ou sem nome de modelo', () => {
    const r = parseUsageResponse({ limits: [{ kind: 'session', percent: 50, scope: null }, { kind: 'weekly_scoped', percent: 10, scope: { model: null } }] });
    expect(r).toBeNull();
  });
  it('janela ausente ou com utilization null é pulada, nunca vira 0 fabricado', () => {
    const r = parseUsageResponse({ five_hour: { utilization: null, resets_at: 'a' }, seven_day: { utilization: 50, resets_at: 'b' } });
    expect(r!.rate_limits.five_hour).toBeUndefined();
    expect(r!.rate_limits.seven_day).toEqual({ utilization: 50, resets_at: 'b' });
  });
  it('sem nenhuma janela nem limite utilizável, devolve null', () => {
    expect(parseUsageResponse({})).toBeNull();
    expect(parseUsageResponse({ five_hour: { utilization: null, resets_at: null } })).toBeNull();
  });
  it('limita utilization em 0-100 mesmo se a API mandar algo fora da faixa', () => {
    const r = parseUsageResponse({ five_hour: { utilization: 142, resets_at: 'a' } });
    expect(r!.rate_limits.five_hour!.utilization).toBe(100);
  });
  it('subscription_type sempre null — esse campo não existe na resposta real', () => {
    const r = parseUsageResponse(RESPOSTA_REAL);
    expect(r!.subscription_type).toBeNull();
  });
});
