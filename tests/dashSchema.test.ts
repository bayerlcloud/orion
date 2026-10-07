import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { ensureDashSamplesTable, insertDashSample } from '../server/dash/schema.js';

describe('dash/schema', () => {
  it('ensureDashSamplesTable cria a tabela com host na chave primária', async () => {
    const sql: string[] = [];
    const pool = { query: async (q: string) => { sql.push(q); return {}; } } as unknown as Pool;
    expect(await ensureDashSamplesTable(pool)).toBe(true);
    expect(sql.some(s => /PRIMARY KEY \(host, ts\)/.test(s))).toBe(true);
  });

  it('ensureDashSamplesTable devolve false e não lança se a query falhar', async () => {
    const pool = { query: async () => { throw new Error('sem conexão'); } } as unknown as Pool;
    expect(await ensureDashSamplesTable(pool)).toBe(false);
  });

  it('ensureDashSamplesTable loga o erro real via log.warn em vez de console', async () => {
    const pool = { query: async () => { throw new Error('sem conexão'); } } as unknown as Pool;
    const warnings: unknown[] = [];
    const log = { info: () => {}, warn: (obj: unknown) => { warnings.push(obj); } };
    expect(await ensureDashSamplesTable(pool, log)).toBe(false);
    expect(warnings).toEqual([{ err: 'Error: sem conexão' }]);
  });

  it('insertDashSample grava com o host certo e poda 7 dias', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const pool = { query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return {}; } } as unknown as Pool;
    await insertDashSample(pool, 'c1', { ok: true });
    expect(calls[0].sql).toMatch(/INSERT INTO dash_samples/);
    expect(calls[0].params).toEqual(['c1', JSON.stringify({ ok: true })]);
    expect(calls.some(c => /DELETE FROM dash_samples/.test(c.sql))).toBe(true);
  });

  it('insertDashSample não lança se a query falhar', async () => {
    const pool = { query: async () => { throw new Error('sem conexão'); } } as unknown as Pool;
    await expect(insertDashSample(pool, 'c1', {})).resolves.toBeUndefined();
  });

  it('insertDashSample loga o erro real via log.warn em vez de console', async () => {
    const pool = { query: async () => { throw new Error('sem conexão'); } } as unknown as Pool;
    const warnings: unknown[] = [];
    const log = { info: () => {}, warn: (obj: unknown) => { warnings.push(obj); } };
    await insertDashSample(pool, 'c1', {}, log);
    expect(warnings).toEqual([{ err: 'Error: sem conexão' }]);
  });
});
