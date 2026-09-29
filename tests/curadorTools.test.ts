import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { fundirMicrofatos, listarMemorias } from '../server/curador/tools.js';
import type { CurQuery } from '../server/curador/proposals.js';

type Chamada = { sql: string; params?: unknown[] };

/** Pool mockado com query e connect (transação da fusão), padrão de memoryDecay.test.ts. */
function fakePool(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  const calls: Chamada[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return responder(sql, params) ?? { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  return { pool, calls, q: query as CurQuery };
}

const par = [
  { id: 1, code: 'fato-a', title: 'Fato A', level: 4, nota: 5 },
  { id: 2, code: 'fato-b', title: 'Fato B', level: 4, nota: 8 },
];

describe('fundirMicrofatos', () => {
  it('funde 4+4: mantida herda a maior nota, removida morre, auditoria vira proposta já aprovada', async () => {
    const { pool, calls } = fakePool((sql) =>
      sql.includes('SELECT id, code') ? { rows: par, rowCount: 2 } : undefined);
    const r = await fundirMicrofatos(pool, { manter_id: 1, remover_id: 2 });
    expect(r).toEqual({ mantida: 'fato-a', removida: 'fato-b', nota: 8 });

    const upd = calls.find((c) => c.sql.includes('UPDATE memories'))!;
    expect(upd.params).toEqual([1, 8]); // GREATEST(5, 8)
    expect(upd.sql).not.toContain('body_md'); // sem corpo_final, o corpo fica como está
    const del = calls.find((c) => c.sql.includes('DELETE FROM memories'))!;
    expect(del.params).toEqual([2]);
    const audit = calls.find((c) => c.sql.includes('INSERT INTO curadoria_propostas'))!;
    expect(audit.sql).toContain("'aprovada'");
    expect(audit.sql).toContain('applied_at');
    expect(String(audit.params?.[0])).toContain('fato-b');
    // tudo dentro da mesma transação
    const idx = (frag: string) => calls.findIndex((c) => c.sql.includes(frag));
    expect(idx('BEGIN')).toBeLessThan(calls.indexOf(upd));
    expect(idx('COMMIT')).toBeGreaterThan(calls.indexOf(audit));
  });

  it('corpo_final substitui o corpo da mantida e marca last_rewritten_at', async () => {
    const { pool, calls } = fakePool((sql) =>
      sql.includes('SELECT id, code') ? { rows: par, rowCount: 2 } : undefined);
    await fundirMicrofatos(pool, { manter_id: 1, remover_id: 2, corpo_final: '# Unificado' });
    const upd = calls.find((c) => c.sql.includes('UPDATE memories'))!;
    expect(upd.sql).toContain('body_md = $3');
    expect(upd.sql).toContain('last_rewritten_at');
    expect(upd.params).toEqual([1, 8, '# Unificado']);
  });

  it('recusa fusão fora do 4+4, ids iguais e memória inexistente (com ROLLBACK)', async () => {
    const nivel3 = fakePool((sql) =>
      sql.includes('SELECT id, code')
        ? { rows: [par[0], { ...par[1], level: 3, nota: null }], rowCount: 2 }
        : undefined);
    await expect(fundirMicrofatos(nivel3.pool, { manter_id: 1, remover_id: 2 })).rejects.toThrow(/nível 4/);
    expect(nivel3.calls.some((c) => c.sql.includes('ROLLBACK'))).toBe(true);
    expect(nivel3.calls.some((c) => c.sql.includes('DELETE'))).toBe(false);

    const { pool } = fakePool(() => undefined);
    await expect(fundirMicrofatos(pool, { manter_id: 1, remover_id: 1 })).rejects.toThrow(/diferentes/);
    await expect(fundirMicrofatos(pool, { manter_id: 0, remover_id: 2 })).rejects.toThrow(/inteiros/);
    await expect(fundirMicrofatos(pool, { manter_id: 1, remover_id: 99 })).rejects.toThrow(/inexistente/);
  });
});

describe('listarMemorias', () => {
  it('lista só níveis 2 a 4, sem corpo por padrão; com_corpo inclui o body_md', async () => {
    const { q, calls } = fakePool((sql) => (sql.includes('FROM memories') ? { rows: [], rowCount: 0 } : undefined));
    await listarMemorias(q, {});
    expect(calls[0].sql).toContain('level BETWEEN 2 AND 4');
    expect(calls[0].sql).not.toContain('body_md');
    expect(calls[1].sql).toMatch(/UPDATE memories SET last_analyzed_at = now\(\) WHERE level BETWEEN 2 AND 4/);
    await listarMemorias(q, { com_corpo: true });
    expect(calls[2].sql).toContain('body_md');
  });
});
