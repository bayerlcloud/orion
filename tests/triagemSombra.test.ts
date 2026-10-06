import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { ensureTriagemSombraTable, gravarTriagemSombra } from '../server/memories/triagemSombra.js';

type Chamada = { sql: string; params?: unknown[] };
function fakePool() {
  const calls: Chamada[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; },
  } as unknown as Pool;
  return { pool, calls };
}

describe('ensureTriagemSombraTable', () => {
  it('cria a tabela sem UNIQUE(sessao_id, seq) — seq é preenchido depois, por timestamp', async () => {
    const { pool, calls } = fakePool();
    await ensureTriagemSombraTable(pool);
    expect(calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS triagem_sombra');
    expect(calls[0].sql).not.toContain('UNIQUE');
  });
});

describe('gravarTriagemSombra', () => {
  it('grava sem o texto do prompt, seq nulo até a junção por timestamp', async () => {
    const { pool, calls } = fakePool();
    const ts = new Date('2026-10-07T10:00:00Z');
    await gravarTriagemSombra(pool, {
      sessaoId: 's1', ts, latenciaMs: 180,
      respostas: { injecao: { label: 'nao', confidence: 0.9 } },
      modeloUsado: null, esforcoUsado: null,
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO triagem_sombra'))!;
    expect(ins.sql).not.toMatch(/prompt/i);
    expect(ins.params).toEqual(['s1', ts, 180, { injecao: { label: 'nao', confidence: 0.9 } }, null, null]);
  });
});
