import { describe, it, expect } from 'vitest';
import {
  ValidationError,
  NOTA_INICIAL,
  nivelColor,
  nivelLabel,
  normalizeKeywords,
  normalizeLevel,
  normalizeNota,
  normalizeScopeId,
  normalizeSummary,
  slugify,
  truncateSummary,
  uniqueCode,
  SUMMARY_MAX,
} from '../server/memories/util.js';
import * as web from '../web/src/pages/memoriaUtils';

describe('slugify', () => {
  it('gera kebab-case sem acentos', () => {
    expect(slugify('Orion é o painel Único!')).toBe('orion-e-o-painel-unico');
  });
  it('colapsa separadores e apara as pontas', () => {
    expect(slugify('  --Regra   de   Ouro-- ')).toBe('regra-de-ouro');
  });
  it('cai em "memoria" quando não sobra nada', () => {
    expect(slugify('!!!')).toBe('memoria');
    expect(slugify('')).toBe('memoria');
  });
  it('limita o tamanho', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('nivelLabel', () => {
  it('um rótulo por andar da pirâmide', () => {
    expect(nivelLabel(0)).toBe('Constituição');
    expect(nivelLabel(1)).toBe('Automática');
    expect(nivelLabel(2)).toBe('Regra');
    expect(nivelLabel(3)).toBe('Decisão');
    expect(nivelLabel(4)).toBe('Micro-fato');
  });
});

describe('nivelColor', () => {
  it('mapeia para os tokens de cor globais', () => {
    expect(nivelColor(0)).toBe('accent');
    expect(nivelColor(1)).toBe('info');
    expect(nivelColor(2)).toBe('ok');
    expect(nivelColor(3)).toBe('warn');
    expect(nivelColor(4)).toBe('fg2');
  });
});

describe('normalizeLevel', () => {
  it('aceita 0 a 4', () => {
    for (const n of [0, 1, 2, 3, 4]) expect(normalizeLevel(n)).toBe(n);
    expect(normalizeLevel('3')).toBe(3);
  });
  it('recusa fora da pirâmide', () => {
    expect(() => normalizeLevel(5)).toThrow(ValidationError);
    expect(() => normalizeLevel(-1)).toThrow(ValidationError);
    expect(() => normalizeLevel(2.5)).toThrow(ValidationError);
    expect(() => normalizeLevel('deus')).toThrow(ValidationError);
  });
});

describe('normalizeNota', () => {
  it('no nível 4: 1..10, vazio vira a nota inicial', () => {
    expect(normalizeNota(4, 7)).toBe(7);
    expect(normalizeNota(4, null)).toBe(NOTA_INICIAL);
    expect(normalizeNota(4, undefined)).toBe(NOTA_INICIAL);
    expect(normalizeNota(4, '')).toBe(NOTA_INICIAL);
    expect(() => normalizeNota(4, 0)).toThrow(ValidationError);
    expect(() => normalizeNota(4, 11)).toThrow(ValidationError);
    expect(() => normalizeNota(4, 5.5)).toThrow(ValidationError);
  });
  it('fora do nível 4, obrigatoriamente null', () => {
    for (const lv of [0, 1, 2, 3]) {
      expect(normalizeNota(lv, null)).toBeNull();
      expect(normalizeNota(lv, undefined)).toBeNull();
      expect(() => normalizeNota(lv, 5)).toThrow(ValidationError);
    }
  });
});

describe('normalizeSummary', () => {
  it(`aceita até ${SUMMARY_MAX} caracteres`, () => {
    expect(normalizeSummary('a'.repeat(SUMMARY_MAX))).toHaveLength(SUMMARY_MAX);
    expect(normalizeSummary('')).toBe('');
    expect(normalizeSummary(undefined)).toBe('');
  });
  it(`recusa acima de ${SUMMARY_MAX}`, () => {
    expect(() => normalizeSummary('a'.repeat(SUMMARY_MAX + 1))).toThrow(ValidationError);
  });
});

describe('truncateSummary (versão tolerante da tool)', () => {
  it('mantém o que cabe', () => {
    expect(truncateSummary('a'.repeat(SUMMARY_MAX))).toHaveLength(SUMMARY_MAX);
    expect(truncateSummary('curto')).toBe('curto');
  });
  it(`corta em ${SUMMARY_MAX} em vez de recusar`, () => {
    const t = truncateSummary('a'.repeat(SUMMARY_MAX + 200));
    expect(t).toHaveLength(SUMMARY_MAX);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('normalizeKeywords', () => {
  it('aceita até 4, tira vazias e repetidas', () => {
    expect(normalizeKeywords(['a', 'b', 'a', '', '  c '])).toEqual(['a', 'b', 'c']);
    expect(normalizeKeywords(null)).toEqual([]);
  });
  it('recusa mais de 4', () => {
    expect(() => normalizeKeywords(['a', 'b', 'c', 'd', 'e'])).toThrow(/4/);
  });
  it('recusa quando não é lista', () => {
    expect(() => normalizeKeywords('a,b,c' as unknown)).toThrow(ValidationError);
  });
});

describe('normalizeScopeId', () => {
  it('vazio vira null (universal)', () => {
    expect(normalizeScopeId(null)).toBeNull();
    expect(normalizeScopeId('')).toBeNull();
    expect(normalizeScopeId(undefined)).toBeNull();
  });
  it('inteiro positivo passa', () => {
    expect(normalizeScopeId(7)).toBe(7);
    expect(normalizeScopeId('7')).toBe(7);
  });
  it('recusa negativo/zero/quebrado', () => {
    expect(() => normalizeScopeId(0)).toThrow(ValidationError);
    expect(() => normalizeScopeId(-1)).toThrow(ValidationError);
    expect(() => normalizeScopeId('abc')).toThrow(ValidationError);
  });
});

describe('uniqueCode', () => {
  it('devolve a base quando está livre', async () => {
    const code = await uniqueCode(async () => ({ rowCount: 0 }), 'Regra de Ouro');
    expect(code).toBe('regra-de-ouro');
  });
  it('acrescenta -2, -3... até achar livre', async () => {
    const ocupados = new Set(['regra-de-ouro', 'regra-de-ouro-2']);
    const code = await uniqueCode(
      async (_sql, params) => ({ rowCount: ocupados.has(params[0] as string) ? 1 : 0 }),
      'Regra de Ouro',
    );
    expect(code).toBe('regra-de-ouro-3');
  });
});

describe('paridade servidor <-> cliente', () => {
  it('nivelLabel, nivelColor e slugify batem', () => {
    for (const lv of [0, 1, 2, 3, 4]) {
      expect(web.nivelLabel(lv)).toBe(nivelLabel(lv));
      expect(web.nivelColor(lv)).toBe(nivelColor(lv));
    }
    expect(web.slugify('Orion é o painel Único!')).toBe(slugify('Orion é o painel Único!'));
    expect(web.NOTA_INICIAL).toBe(NOTA_INICIAL);
  });
});
