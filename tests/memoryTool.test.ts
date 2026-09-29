import { describe, it, expect } from 'vitest';
import { buscarMemorias, salvarMemoria, type MemQuery, type MemoryToolCtx } from '../server/claude/memoryTool.js';

const ctx: MemoryToolCtx = { sessionId: 'sess-1', projectId: 1, userId: 1 };

type Chamada = { sql: string; params?: unknown[] };

/** Query mockada: registra as chamadas e responde pelo pedaço de SQL. */
function fakeQuery(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  const calls: Chamada[] = [];
  const q: MemQuery = async (sql, params) => {
    calls.push({ sql, params });
    return responder(sql, params) ?? { rows: [], rowCount: 0 };
  };
  return { q, calls };
}

const memRow = (p: Partial<Record<string, unknown>> = {}) => ({
  id: 42, code: 'orion-coletor-cpu-sem-iowait', level: 4, nota: 5,
  title: 'Coletor não soma iowait', summary: 'resumo', body_md: 'corpo', ...p,
});

describe('buscar', () => {
  it('acha por full-text, deixa rastro de acesso e sobe a nota do micro-fato (1x/dia, teto 10)', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('plainto_tsquery') && sql.trimStart().startsWith('SELECT')) return { rows: [memRow()], rowCount: 1 };
      if (sql.includes('LEAST(nota + 1, 10)')) return { rows: [{ id: 42, nota: 6 }], rowCount: 1 };
      return undefined;
    });
    const r = await buscarMemorias(q, ctx, { consulta: 'iowait cpu' });
    expect(r).toEqual([{ code: 'orion-coletor-cpu-sem-iowait', nivel: 4, nota: 6, titulo: 'Coletor não soma iowait', resumo: 'resumo', corpo: 'corpo' }]);

    const bump = calls.find((c) => c.sql.includes('LEAST(nota + 1, 10)'))!;
    expect(bump.sql).toContain("last_accessed_at::date <> current_date"); // no máximo 1x/dia por memória
    expect(bump.sql).toContain('level = 4'); // nota é exclusiva do nível 4
    const rastro = calls.find((c) => c.sql.includes('last_accessed_session'))!;
    expect(rastro.params?.[1]).toBe('sess-1');
    expect(String(rastro.params?.[2])).toContain('orion-memory');
    expect(String(rastro.params?.[2])).toContain('iowait cpu');
    // a elegibilidade do bump olha o last_accessed_at ANTERIOR: bump vem antes do rastro
    expect(calls.indexOf(bump)).toBeLessThan(calls.indexOf(rastro));
  });

  it('sem resultado no full-text, cai para ILIKE', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('plainto_tsquery') && sql.trimStart().startsWith('SELECT')) return { rows: [], rowCount: 0 };
      if (sql.includes('ILIKE')) return { rows: [memRow({ level: 3, nota: null })], rowCount: 1 };
      return undefined;
    });
    const r = await buscarMemorias(q, ctx, { consulta: 'xyzabc' });
    expect(r).toHaveLength(1);
    expect(r[0].nivel).toBe(3);
    expect(r[0].nota).toBeNull();
    expect(calls.some((c) => c.sql.includes('ILIKE'))).toBe(true);
    // nível 3 não ganha bump de nota, mas o rastro de acesso fica
    expect(calls.some((c) => c.sql.includes('last_accessed_session'))).toBe(true);
  });

  it('nada encontrado: devolve vazio sem deixar rastro', async () => {
    const { q, calls } = fakeQuery(() => undefined);
    const r = await buscarMemorias(q, ctx, { consulta: 'nada' });
    expect(r).toEqual([]);
    expect(calls.some((c) => c.sql.includes('last_accessed_session'))).toBe(false);
  });

  it('só busca nos níveis 2-4; nivel fora disso é recusado', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.trimStart().startsWith('SELECT') ? { rows: [], rowCount: 0 } : undefined);
    await buscarMemorias(q, ctx, { consulta: 'x', nivel: 4 });
    expect(calls[0].sql).toContain('level BETWEEN 2 AND 4');
    expect(calls[0].params?.[1]).toBe(4);
    await expect(buscarMemorias(q, ctx, { consulta: 'x', nivel: 1 })).rejects.toThrow(/2 a 4/);
    await expect(buscarMemorias(q, ctx, { consulta: '  ' })).rejects.toThrow(/consulta/);
  });
});

describe('salvar', () => {
  it('recusa níveis 0 e 1 com mensagem clara (escada de escrita)', async () => {
    const { q } = fakeQuery(() => undefined);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 0 })).rejects.toThrow(/Danilo/);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 1 })).rejects.toThrow(/gerador/);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 7 })).rejects.toThrow(/2 a 4/);
  });

  it('sem nível vira micro-fato (4) e nasce com nota 5; código único vem do slug do título', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const r = await salvarMemoria(q, ctx, { titulo: 'VNC exposto na c2', corpo: 'fechar a porta' });
    expect(r).toEqual({ code: 'vnc-exposto-na-c2', nivel: 4, nota: 5 });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.params).toEqual(['vnc-exposto-na-c2', 'VNC exposto na c2', '', 'fechar a porta', 4, 5, [], null, null]);
  });

  it('nível 3 nasce sem nota; resumo estoura 144 e é cortado; keywords passam de 4 e sobram 4', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const r = await salvarMemoria(q, ctx, {
      titulo: 'Painel único', corpo: 'c', nivel: 3,
      resumo: 'a'.repeat(200),
      keywords: ['a', 'b', 'c', 'd', 'e'],
      escopo_projeto_id: 1,
    });
    expect(r.nivel).toBe(3);
    expect(r.nota).toBeNull();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    const [, , resumo, , nivel, nota, keywords, escopoProjeto] = insert.params as any[];
    expect(String(resumo)).toHaveLength(144);
    expect(nivel).toBe(3);
    expect(nota).toBeNull();
    expect(keywords).toEqual(['a', 'b', 'c', 'd']);
    expect(escopoProjeto).toBe(1);
  });

  it('exige título', async () => {
    const { q } = fakeQuery(() => undefined);
    await expect(salvarMemoria(q, ctx, { titulo: '  ', corpo: 'y' })).rejects.toThrow(/título/);
  });
});
