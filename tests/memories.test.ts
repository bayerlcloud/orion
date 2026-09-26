import { describe, it, expect } from 'vitest';
import {
  ValidationError,
  importanceRank,
  normalizeKeywords,
  normalizeLearningLevel,
  normalizeScopeId,
  normalizeStatus,
  normalizeSummary,
  slugify,
  statusColor,
  statusLabel,
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

describe('importanceRank', () => {
  it('ordena deus > aprendizagem 5..1 > rascunho', () => {
    const ranks = [
      importanceRank('deus'),
      importanceRank('aprendizagem', 5),
      importanceRank('aprendizagem', 4),
      importanceRank('aprendizagem', 3),
      importanceRank('aprendizagem', 2),
      importanceRank('aprendizagem', 1),
      importanceRank('rascunho'),
    ];
    expect(ranks).toEqual([7, 6, 5, 4, 3, 2, 1]);
    // estritamente decrescente
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThan(ranks[i - 1]);
  });
  it('nível ausente na aprendizagem não quebra', () => {
    expect(importanceRank('aprendizagem', null)).toBe(2);
  });
});

describe('statusLabel', () => {
  it('rótulos legíveis', () => {
    expect(statusLabel('deus')).toBe('Deus');
    expect(statusLabel('aprendizagem', 4)).toBe('Aprendizagem 4');
    expect(statusLabel('rascunho')).toBe('Rascunho');
  });
});

describe('statusColor', () => {
  it('mapeia para os tokens de cor', () => {
    expect(statusColor('deus')).toBe('accent');
    expect(statusColor('aprendizagem', 5)).toBe('info');
    expect(statusColor('aprendizagem', 4)).toBe('info');
    expect(statusColor('aprendizagem', 3)).toBe('info');
    expect(statusColor('aprendizagem', 2)).toBe('warn');
    expect(statusColor('aprendizagem', 1)).toBe('warn');
    expect(statusColor('rascunho')).toBe('fg2');
  });
});

describe('normalizeSummary', () => {
  it('aceita até 144 caracteres', () => {
    expect(normalizeSummary('a'.repeat(SUMMARY_MAX))).toHaveLength(144);
    expect(normalizeSummary('')).toBe('');
    expect(normalizeSummary(undefined)).toBe('');
  });
  it('recusa acima de 144', () => {
    expect(() => normalizeSummary('a'.repeat(145))).toThrow(ValidationError);
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

describe('normalizeStatus', () => {
  it('aceita os três válidos', () => {
    expect(normalizeStatus('deus')).toBe('deus');
    expect(normalizeStatus('aprendizagem')).toBe('aprendizagem');
    expect(normalizeStatus('rascunho')).toBe('rascunho');
  });
  it('recusa outros', () => {
    expect(() => normalizeStatus('outro')).toThrow(ValidationError);
  });
});

describe('normalizeLearningLevel', () => {
  it('exige 1..5 na aprendizagem', () => {
    expect(normalizeLearningLevel('aprendizagem', 3)).toBe(3);
    expect(() => normalizeLearningLevel('aprendizagem', 0)).toThrow(ValidationError);
    expect(() => normalizeLearningLevel('aprendizagem', 6)).toThrow(ValidationError);
    expect(() => normalizeLearningLevel('aprendizagem', null)).toThrow(ValidationError);
    expect(() => normalizeLearningLevel('aprendizagem', 2.5)).toThrow(ValidationError);
  });
  it('obriga null fora da aprendizagem', () => {
    expect(normalizeLearningLevel('deus', null)).toBeNull();
    expect(normalizeLearningLevel('rascunho', undefined)).toBeNull();
    expect(() => normalizeLearningLevel('deus', 3)).toThrow(ValidationError);
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

describe('paridade servidor <-> cliente', () => {
  it('importanceRank, statusLabel, statusColor e slugify batem', () => {
    const casos: { s: string; l: number | null }[] = [
      { s: 'deus', l: null },
      { s: 'aprendizagem', l: 5 },
      { s: 'aprendizagem', l: 2 },
      { s: 'rascunho', l: null },
    ];
    for (const { s, l } of casos) {
      expect(web.importanceRank(s, l)).toBe(importanceRank(s, l));
      expect(web.statusLabel(s, l)).toBe(statusLabel(s, l));
      expect(web.statusColor(s, l)).toBe(statusColor(s, l));
    }
    expect(web.slugify('Orion é o painel Único!')).toBe(slugify('Orion é o painel Único!'));
  });
});
