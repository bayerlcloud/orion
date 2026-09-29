// Teste REAL do embed.ts: baixa o modelo intfloat/multilingual-e5-small (uma vez, cache em
// TRANSFORMERS_CACHE) e roda inferência de verdade. Por isso fica atrás de RODAR_EMBED=1:
//   RODAR_EMBED=1 npm test -- tests/embed.test.ts
// O restante da lógica (busca híbrida, salvar) roda com embedder mockado em memoryTool.test.ts.
import { describe, it, expect } from 'vitest';

const rodar = process.env.RODAR_EMBED === '1';

describe.skipIf(!rodar)('embed real (RODAR_EMBED=1)', () => {
  it('gera vetor de 384 dimensões, normalizado, e aproxima textos parecidos', async () => {
    const { EMBED_DIM, embedConsulta, embedCorpo, vetorSql } = await import('../server/memories/embed.js');

    const corpoPerto = await embedCorpo('o coletor de métricas somava iowait no uso de CPU');
    expect(corpoPerto).toHaveLength(EMBED_DIM);
    const norma = Math.hypot(...corpoPerto);
    expect(norma).toBeCloseTo(1, 2); // normalizado: cosseno = produto interno

    const consulta = await embedConsulta('bug de iowait no coletor');
    const corpoLonge = await embedCorpo('receita de bolo de cenoura com cobertura de chocolate');
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(consulta, corpoPerto)).toBeGreaterThan(dot(consulta, corpoLonge));

    // literal aceito pelo cast ::vector
    expect(vetorSql([0.25, -1])).toBe('[0.25,-1]');
  }, 600_000);
});
