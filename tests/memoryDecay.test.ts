import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { decairMicrofatos, CHAVE_GUARDA } from '../server/memories/decay.js';

type Chamada = { sql: string; params?: unknown[] };

/** Pool mockado com pool.query e pool.connect (transação do decaimento). */
function fakePool(opts: { ultimoDia?: string | null; mortas?: string[]; decaidas?: string[]; falhaNoUpdate?: boolean }) {
  const calls: Chamada[] = [];
  const responde = (sql: string) => {
    if (sql.includes('SELECT value FROM settings')) {
      return { rows: opts.ultimoDia ? [{ value: opts.ultimoDia }] : [], rowCount: opts.ultimoDia ? 1 : 0 };
    }
    if (sql.trimStart().startsWith('DELETE FROM memories')) {
      return { rows: (opts.mortas ?? []).map((code) => ({ code })), rowCount: (opts.mortas ?? []).length };
    }
    if (sql.includes('SET nota = nota - 1')) {
      if (opts.falhaNoUpdate) throw new Error('falhou de propósito');
      return { rows: (opts.decaidas ?? []).map((code) => ({ code })), rowCount: (opts.decaidas ?? []).length };
    }
    return { rows: [], rowCount: 0 };
  };
  const query = async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return responde(sql); };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('decairMicrofatos', () => {
  it('guarda de 1x/dia: se já rodou hoje, não toca no banco', async () => {
    const { pool, calls } = fakePool({ ultimoDia: '2026-09-28' });
    const r = await decairMicrofatos(pool, '2026-09-28');
    expect(r).toEqual({ pulado: true, decaidas: [], mortas: [] });
    expect(calls.some((c) => c.sql.includes('nota - 1'))).toBe(false);
    expect(calls.some((c) => c.sql.trimStart().startsWith('DELETE FROM memories'))).toBe(false);
  });

  it('dia novo: mata quem chegaria a 0, decrementa o resto (só nível 4, 30 dias sem toque) e grava a guarda', async () => {
    const { pool, calls } = fakePool({ ultimoDia: '2026-09-27', mortas: ['fato-velho'], decaidas: ['fato-parado'] });
    const r = await decairMicrofatos(pool, '2026-09-28');
    expect(r).toEqual({ pulado: false, decaidas: ['fato-parado'], mortas: ['fato-velho'] });

    const del = calls.find((c) => c.sql.trimStart().startsWith('DELETE FROM memories'))!;
    const upd = calls.find((c) => c.sql.includes('SET nota = nota - 1'))!;
    for (const c of [del, upd]) {
      expect(c.sql).toContain('level = 4');
      expect(c.sql).toContain("interval '30 days'");
      expect(c.sql).toContain('last_decay_at'); // o próprio decaimento conta como toque (greatest)
    }
    expect(del.sql).toContain('nota <= 1'); // morre antes de encostar em 0 (CHECK 1..10)
    // a morte vem antes do decremento, na mesma transação
    expect(calls.indexOf(del)).toBeLessThan(calls.indexOf(upd));
    const idx = (frag: string) => calls.findIndex((c) => c.sql.includes(frag));
    expect(idx('BEGIN')).toBeLessThan(calls.indexOf(del));
    expect(idx('COMMIT')).toBeGreaterThan(calls.indexOf(upd));

    const guarda = calls.find((c) => c.sql.includes('INSERT INTO settings'))!;
    expect(guarda.params?.[0]).toBe(CHAVE_GUARDA);
    expect(guarda.params?.[1]).toBe('2026-09-28');
  });

  it('primeira rodada da vida (sem guarda gravada) roda normalmente', async () => {
    const { pool } = fakePool({ ultimoDia: null });
    const r = await decairMicrofatos(pool, '2026-09-28');
    expect(r.pulado).toBe(false);
  });

  it('erro no meio: ROLLBACK e a guarda do dia NÃO é gravada (o próximo ciclo tenta de novo)', async () => {
    const { pool, calls } = fakePool({ ultimoDia: null, falhaNoUpdate: true });
    await expect(decairMicrofatos(pool, '2026-09-28')).rejects.toThrow('falhou de propósito');
    expect(calls.some((c) => c.sql.includes('ROLLBACK'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO settings'))).toBe(false);
  });
});
