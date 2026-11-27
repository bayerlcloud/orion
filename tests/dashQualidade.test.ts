import { describe, it, expect } from 'vitest';
import { diasValidos, montarQualidade, sqlQualidade } from '../server/dash/qualidade.js';

const l = (nome: string | null, o: Record<string, string> = {}) => ({
  nome, sessoes: '1', turnos: '2', tokens_in: '100', tokens_out: '10', compactacoes: '0', cortados: '0', publicacoes: '0', erros: '0', ...o,
});

describe('montarQualidade', () => {
  it('converte strings do pg, ordena por tokens de saída e soma o total', () => {
    const r = montarQualidade(7, [l('a', { tokens_out: '5', erros: '1' }), l('b', { tokens_out: '50', publicacoes: '3', sessoes: '4' })], [l('Ana')]);
    expect(r.por_projeto.map(x => x.nome)).toEqual(['b', 'a']);
    expect(r.total).toMatchObject({ nome: 'Total', sessoes: 5, turnos: 4, tokens_in: 200, tokens_out: 55, publicacoes: 3, erros: 1 });
    expect(r.por_pessoa).toHaveLength(1);
  });
  it('nome nulo vira rótulo e lista vazia dá total zerado', () => {
    expect(montarQualidade(30, [l(null)], [l(null)]).por_projeto[0].nome).toBe('(sem projeto)');
    expect(montarQualidade(30, [l(null)], [l(null)]).por_pessoa[0].nome).toBe('(sem pessoa)');
    expect(montarQualidade(7, [], []).total.sessoes).toBe(0);
  });
});

describe('diasValidos / sql', () => {
  it('só 30 vira 30; o resto é 7', () => {
    expect(diasValidos('30')).toBe(30);
    expect(diasValidos('90')).toBe(7);
    expect(diasValidos(undefined)).toBe(7);
  });
  it('sql agrupa pela dimensão certa', () => {
    expect(sqlQualidade('projeto')).toContain('JOIN projects d');
    expect(sqlQualidade('pessoa')).toContain('JOIN users d');
  });
});
