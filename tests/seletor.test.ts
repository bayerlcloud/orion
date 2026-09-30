import { describe, it, expect } from 'vitest';
import { ULTRACODE, ULTRACODE_APPEND, resolveUltracode, withUltracodeAppend } from '../server/claude/ultracode';
import { computeModelAttribution } from '../web/src/claude/mapper';
import { fastModeFrom, applyLive, emptyLive } from '../web/src/claude/live';
import { matchEffort, effortPillLabel, ULTRACODE_LABEL, ULTRACODE_MENU_LABEL } from '../web/src/claude/api';

/**
 * Trilha par/seletor (29/09/2026) — ver web/src/claude/PARIDADE-seletor.md:
 * degrau "Ultracode" no seletor de esforço, indicador de fast mode e "% do uso" por modelo.
 */

describe('resolveUltracode (server/claude/ultracode.ts)', () => {
  it("'ultracode' vira esforço xhigh + flag ligada (mesma semântica do enableUltracode real: effortLevel='xhigh' + flag)", () => {
    expect(resolveUltracode(ULTRACODE)).toEqual({ effort: 'xhigh', ultracode: true });
  });
  it('níveis reais passam intactos, sem flag', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolveUltracode(e)).toEqual({ effort: e, ultracode: false });
    }
  });
  it('null/undefined/lixo viram "sem override", sem flag', () => {
    expect(resolveUltracode(null)).toEqual({ ultracode: false });
    expect(resolveUltracode(undefined)).toEqual({ ultracode: false });
    expect(resolveUltracode('urgent')).toEqual({ ultracode: false });
    expect(resolveUltracode('')).toEqual({ ultracode: false });
  });
});

describe('withUltracodeAppend', () => {
  it('acrescenta a instrução de orquestração só com a flag ligada', () => {
    expect(withUltracodeAppend('base', true)).toBe(`base\n\n${ULTRACODE_APPEND}`);
    expect(withUltracodeAppend('base', false)).toBe('base');
  });
  it('a instrução cita subagentes/Task e não usa travessão (regra do projeto)', () => {
    expect(ULTRACODE_APPEND).toContain('subagentes');
    expect(ULTRACODE_APPEND).toContain('Task');
    expect(ULTRACODE_APPEND).not.toMatch(/[–—]/);
  });
});

describe('matchEffort/effortPillLabel com o degrau Ultracode', () => {
  it("'ultracode' persistido é restaurado como está (não cai pra medium)", () => {
    expect(matchEffort('ultracode')).toBe('ultracode');
  });
  it('pill mostra "Ultracode" (IV0 real), menu mostra a string literal exata da extensão (fe real)', () => {
    expect(effortPillLabel('ultracode')).toBe(ULTRACODE_LABEL);
    expect(ULTRACODE_LABEL).toBe('Ultracode');
    expect(ULTRACODE_MENU_LABEL).toBe('Ultracode - xhigh + workflows');
    expect(effortPillLabel('max')).toBe('Máximo');
  });
});

describe('computeModelAttribution (% do uso por modelo)', () => {
  it('agrupa ids diferentes do mesmo alias, calcula %, ordena desc', () => {
    const out = computeModelAttribution([
      { model: 'claude-sonnet-5', tokens: '3' },
      { model: 'claude-sonnet-4-5', tokens: 1 },
      { model: 'claude-fable-5', tokens: '6' },
    ]);
    expect(out).toEqual([
      { name: 'Fable', pct: 60 },
      { name: 'Sonnet', pct: 40 },
    ]);
  });
  it('modelo null é pulado; id sem alias conhecido fica com o id cru', () => {
    const out = computeModelAttribution([
      { model: null, tokens: 100 },
      { model: 'gpt-x', tokens: 1 },
      { model: 'claude-opus-4-1', tokens: 3 },
    ]);
    expect(out).toEqual([
      { name: 'Opus', pct: 75 },
      { name: 'gpt-x', pct: 25 },
    ]);
  });
  it('sem custo nenhum (ou lista vazia/ausente) devolve lista vazia, nunca % de divisão por zero', () => {
    expect(computeModelAttribution([])).toEqual([]);
    expect(computeModelAttribution(undefined)).toEqual([]);
    expect(computeModelAttribution([{ model: 'claude-sonnet-5', tokens: 0 }])).toEqual([]);
  });
  it('custo não numérico conta como zero, sem NaN', () => {
    const out = computeModelAttribution([
      { model: 'claude-sonnet-5', tokens: 'abc' as unknown as string },
      { model: 'claude-haiku-4', tokens: 2 },
    ]);
    expect(out).toEqual([{ name: 'Haiku', pct: 100 }, { name: 'Sonnet', pct: 0 }]);
  });
});

describe('fastModeFrom / fastMode em LiveState', () => {
  it('lê fast_mode_state válido de uma mensagem do SDK; inválido/ausente vira undefined', () => {
    expect(fastModeFrom({ type: 'result', fast_mode_state: 'on' })).toBe('on');
    expect(fastModeFrom({ type: 'system', subtype: 'init', fast_mode_state: 'cooldown' })).toBe('cooldown');
    expect(fastModeFrom({ type: 'result', fast_mode_state: 'off' })).toBe('off');
    expect(fastModeFrom({ type: 'result' })).toBeUndefined();
    expect(fastModeFrom({ type: 'result', fast_mode_state: 'turbo' })).toBeUndefined();
    expect(fastModeFrom(null)).toBeUndefined();
  });
  it("começa 'off'; um result com fast_mode_state atualiza; mensagem sem o campo mantém o valor", () => {
    let s = emptyLive();
    expect(s.fastMode).toBe('off');
    s = applyLive(s, { type: 'message', message: { type: 'result', subtype: 'success', fast_mode_state: 'on', uuid: 'u1' } });
    expect(s.fastMode).toBe('on');
    s = applyLive(s, { type: 'message', message: { type: 'assistant', message: { content: [] }, uuid: 'u2' } });
    expect(s.fastMode).toBe('on');
    s = applyLive(s, { type: 'message', message: { type: 'result', subtype: 'success', fast_mode_state: 'cooldown', uuid: 'u3' } });
    expect(s.fastMode).toBe('cooldown');
  });
});
