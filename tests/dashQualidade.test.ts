import { describe, it, expect } from 'vitest';
import { diasValidos, montarQualidade, SQL_QUALIDADE } from '../server/dash/qualidade.js';

const l = (projeto: string | null, pessoa: string | null, o: Record<string, string> = {}) => ({
  projeto, pessoa, sessoes: '1', turnos: '2', tokens_in: '100', tokens_out: '10', compactacoes: '0', cortados: '0', publicacoes: '0', erros: '0', ...o,
});

describe('montarQualidade', () => {
  it('agrupa nas duas dimensões, ordena por tokens de saída e o total fecha', () => {
    const r = montarQualidade(7, [
      l('a', 'Ana', { tokens_out: '5', erros: '1' }),
      l('b', 'Ana', { tokens_out: '50', publicacoes: '3', sessoes: '4' }),
      l('b', 'Beto', { tokens_out: '20' }),
    ]);
    expect(r.por_projeto.map(x => x.nome)).toEqual(['b', 'a']);
    expect(r.por_projeto[0]).toMatchObject({ sessoes: 5, tokens_out: 70, tokens_in: 200 });
    expect(r.por_pessoa.map(x => x.nome)).toEqual(['Ana', 'Beto']);
    expect(r.por_pessoa[0]).toMatchObject({ sessoes: 5, tokens_out: 55, publicacoes: 3, erros: 1 });
    expect(r.total).toMatchObject({ nome: 'Total', sessoes: 6, turnos: 6, tokens_in: 300, tokens_out: 75, publicacoes: 3, erros: 1 });
    expect(r.por_pessoa.reduce((s, x) => s + x.sessoes, 0)).toBe(r.total.sessoes);
  });
  it('nome nulo vira rótulo e lista vazia dá total zerado', () => {
    const r = montarQualidade(30, [l(null, null)]);
    expect(r.por_projeto[0].nome).toBe('(sem projeto)');
    expect(r.por_pessoa[0].nome).toBe('(sem pessoa)');
    expect(montarQualidade(7, []).total.sessoes).toBe(0);
  });
});

describe('diasValidos / sql', () => {
  it('só 30 vira 30; o resto é 7', () => {
    expect(diasValidos('30')).toBe(30);
    expect(diasValidos('90')).toBe(7);
    expect(diasValidos(undefined)).toBe(7);
  });
  it('sql usa usage dos results, não os acumulados da sessão', () => {
    expect(SQL_QUALIDADE).toContain("payload->'usage'");
    expect(SQL_QUALIDADE).not.toContain('s.input_tokens');
  });
});
