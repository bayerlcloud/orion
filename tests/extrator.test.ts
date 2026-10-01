import { describe, it, expect } from 'vitest';
import { MAX_FATOS_POR_PROJETO, NOTA_EXTRATOR, montarTranscricao, novasStats, registrarFato } from '../server/curador/extrator.js';
import type { MemQuery } from '../server/claude/memoryTool.js';

function fakeQuery(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const q: MemQuery = async (sql, params) => { calls.push({ sql, params }); return responder(sql, params) ?? { rows: [], rowCount: 0 }; };
  return { q, calls };
}

describe('montarTranscricao', () => {
  it('uma linha por turno com hora, autor, pedido e resposta; passou do teto fica o fim', () => {
    const t = montarTranscricao([
      { ts: new Date(2026, 9, 1, 14, 5), autor_nome: 'Laís', prompt: 'troca o favicon', resposta: 'trocado e no ar' },
      { ts: new Date(2026, 9, 1, 15, 0), autor_nome: null, prompt: 'x', resposta: '' },
    ]);
    expect(t).toContain('[01/10 14:05] Laís: troca o favicon\n-> trocado e no ar');
    expect(t).toContain('[01/10 15:00] alguém: x');
    const longo = montarTranscricao([{ ts: new Date(), autor_nome: 'A', prompt: 'a'.repeat(800), resposta: 'FIM' }], 50);
    expect(longo).toHaveLength(50);
    expect(longo.endsWith('FIM')).toBe(true);
  });
});

describe('registrarFato', () => {
  const ctx = () => ({ projetoId: 5, ownerId: 1, fatosNestaRodada: { n: 0 } });

  it('grava micro-fato nível 4 com nota 3, origem extrator, autor pelo nome e escopo do projeto', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('FROM users WHERE lower(name)')) return { rows: [{ id: 3 }], rowCount: 1 };
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const stats = novasStats(); const c = ctx();
    const r = await registrarFato(q, c, { titulo: 'TM: conector por API', corpo: 'Guilherme, 01/10: API oficial', autor_nome: 'Guilherme' }, stats);
    expect(r).toEqual({ registrado: true, code: 'tm-conector-por-api' });
    const ins = calls.find((x) => x.sql.includes('INSERT INTO memories'))!;
    expect(ins.params?.slice(4, 6)).toEqual([4, NOTA_EXTRATOR]);
    expect(ins.params?.slice(7, 12)).toEqual([5, null, 3, 'extrator', 'extrator']);
    expect(stats.fatos).toBe(1); expect(c.fatosNestaRodada.n).toBe(1);
  });

  it('decisão vira proposta de promoção; limite por rodada; duplicata não conta', async () => {
    const { q } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1') && sql.includes('SELECT id FROM memories')) return { rows: [{ id: 9 }], rowCount: 1 };
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM memories WHERE id = ANY')) return { rows: [{ id: 9, code: 'd', title: 'd', level: 4, nota: 3, rewritable: true }], rowCount: 1 };
      if (sql.includes('INSERT INTO curadoria_propostas')) return { rows: [{ id: 21 }], rowCount: 1 };
      return undefined;
    });
    const stats = novasStats(); const c = ctx();
    const r = await registrarFato(q, c, { titulo: 'Decisão', corpo: 'Danilo, 01/10: fechado', decisao: true }, stats);
    expect(r).toEqual({ registrado: true, code: 'decisao', proposta: 21 });
    expect(stats.propostas).toBe(1);

    c.fatosNestaRodada.n = MAX_FATOS_POR_PROJETO;
    const lim = await registrarFato(q, c, { titulo: 'x', corpo: 'y' }, stats);
    expect(lim).toMatchObject({ registrado: false });
    expect((lim as any).motivo).toContain('limite');
  });
});
