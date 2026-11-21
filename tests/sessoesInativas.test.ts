import { describe, it, expect } from 'vitest';
import { arquivarSessoesPassadas, DIAS_PADRAO, type PoolLike } from '../server/sessoesInativas';

function fakePool(rowCount: number): { pool: PoolLike; chamadas: { sql: string; params?: unknown[] }[] } {
  const chamadas: { sql: string; params?: unknown[] }[] = [];
  const pool: PoolLike = {
    async query(sql, params) {
      chamadas.push({ sql, params });
      return { rows: [], rowCount };
    },
  };
  return { pool, chamadas };
}

describe('arquivarSessoesPassadas', () => {
  it('arquiva e desafixa sessões paradas há mais de 30 dias, devolve quantas', async () => {
    const { pool, chamadas } = fakePool(3);
    const n = await arquivarSessoesPassadas(pool);
    expect(n).toBe(3);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].sql).toMatch(/archived = true/);
    expect(chamadas[0].sql).toMatch(/pinned = false/);
    expect(chamadas[0].sql).toMatch(/archived IS NOT TRUE AND pinned IS NOT TRUE/);
    expect(chamadas[0].params).toEqual([DIAS_PADRAO]);
  });

  it('aceita um teto de dias diferente do padrão', async () => {
    const { pool, chamadas } = fakePool(0);
    const n = await arquivarSessoesPassadas(pool, 7);
    expect(n).toBe(0);
    expect(chamadas[0].params).toEqual([7]);
  });

  it('rowCount nulo vira 0', async () => {
    const pool: PoolLike = { async query() { return { rows: [], rowCount: null }; } };
    expect(await arquivarSessoesPassadas(pool)).toBe(0);
  });
});
