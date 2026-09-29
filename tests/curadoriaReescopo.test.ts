import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  aplicarProposta,
  criarProposta,
  descreverEscopo,
  ensureCuradoriaTable,
  normalizarEscopoNovo,
  type CurQuery,
  type PropostaPayload,
} from '../server/curador/proposals.js';
import { listarProjetos } from '../server/curador/tools.js';

type Chamada = { sql: string; params?: unknown[] };

function fakeQuery(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  const calls: Chamada[] = [];
  const q: CurQuery = async (sql, params) => {
    calls.push({ sql, params });
    return responder(sql, params) ?? { rows: [], rowCount: 0 };
  };
  return { q, calls };
}

const mem = (p: Partial<Record<string, unknown>> = {}) => ({
  id: 1, code: 'fato-a', title: 'Fato A', level: 3, nota: null, rewritable: true,
  scope_project_id: null, scope_user_id: null, ...p,
});

describe('normalizarEscopoNovo', () => {
  it('aceita projeto, usuário ou universal explícito, sempre normalizado', () => {
    expect(normalizarEscopoNovo({ scope_project_id: 5 })).toEqual({ scope_project_id: 5, scope_user_id: null });
    expect(normalizarEscopoNovo({ scope_user_id: 2 })).toEqual({ scope_project_id: null, scope_user_id: 2 });
    expect(normalizarEscopoNovo({ universal: true })).toEqual({ scope_project_id: null, scope_user_id: null });
    expect(normalizarEscopoNovo({ scope_project_id: '5' })).toEqual({ scope_project_id: 5, scope_user_id: null });
  });

  it('recusa objeto vazio, não-objeto, os dois escopos juntos e universal com id', () => {
    expect(() => normalizarEscopoNovo(undefined)).toThrow(/escopo_novo/);
    expect(() => normalizarEscopoNovo('projeto')).toThrow(/escopo_novo/);
    expect(() => normalizarEscopoNovo([])).toThrow(/escopo_novo/);
    expect(() => normalizarEscopoNovo({})).toThrow(/precisa indicar/);
    expect(() => normalizarEscopoNovo({ universal: false })).toThrow(/precisa indicar/);
    expect(() => normalizarEscopoNovo({ scope_project_id: 5, scope_user_id: 2 })).toThrow(/nunca os dois/);
    expect(() => normalizarEscopoNovo({ universal: true, scope_project_id: 5 })).toThrow(/não combina/);
    expect(() => normalizarEscopoNovo({ scope_project_id: 0 })).toThrow(/inválido/);
    expect(() => normalizarEscopoNovo({ scope_user_id: -3 })).toThrow(/inválido/);
  });

  it('descreverEscopo cobre os três formatos', () => {
    expect(descreverEscopo({ scope_project_id: 5, scope_user_id: null })).toBe('projeto 5');
    expect(descreverEscopo({ scope_project_id: null, scope_user_id: 2 })).toBe('usuário 2');
    expect(descreverEscopo({ scope_project_id: null, scope_user_id: null })).toBe('universal');
  });
});

describe('criarProposta reescopo', () => {
  it('grava a proposta com escopo_novo normalizado no payload, checando que o projeto existe', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('FROM memories')) return { rows: [mem()], rowCount: 1 };
      if (sql.includes('FROM projects')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO curadoria_propostas')) return { rows: [{ id: 11 }], rowCount: 1 };
      return undefined;
    });
    const r = await criarProposta(q, {
      tipo: 'reescopo', memoria_ids: [1], escopo_novo: { scope_project_id: 5 }, justificativa: 'só fala do brandspace',
    });
    expect(r.id).toBe(11);
    expect(r.tipo).toBe('reescopo');
    expect(r.payload.escopo_novo).toEqual({ scope_project_id: 5, scope_user_id: null });
    const checagem = calls.find((c) => c.sql.includes('FROM projects'))!;
    expect(checagem.params).toEqual([5]);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO curadoria_propostas'))!;
    expect(insert.params?.[0]).toBe('reescopo');
    expect(String(insert.params?.[1])).toContain('"scope_project_id":5');
  });

  it('reescopo para usuário checa a tabela users', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('FROM memories')) return { rows: [mem()], rowCount: 1 };
      if (sql.includes('FROM users')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO curadoria_propostas')) return { rows: [{ id: 12 }], rowCount: 1 };
      return undefined;
    });
    const r = await criarProposta(q, {
      tipo: 'reescopo', memoria_ids: [1], escopo_novo: { scope_user_id: 2 }, justificativa: 'é do perfil do Danilo',
    });
    expect(r.payload.escopo_novo).toEqual({ scope_project_id: null, scope_user_id: 2 });
    expect(calls.find((c) => c.sql.includes('FROM users'))!.params).toEqual([2]);
  });

  it('recusa mais de 1 memória, escopo_novo ausente, projeto/usuário inexistente e escopo igual ao atual', async () => {
    const duas = fakeQuery((sql) =>
      sql.includes('FROM memories') ? { rows: [mem(), mem({ id: 2, code: 'fato-b' })], rowCount: 2 } : undefined);
    await expect(criarProposta(duas.q, { tipo: 'reescopo', memoria_ids: [1, 2], escopo_novo: { universal: true }, justificativa: 'x' }))
      .rejects.toThrow(/exatamente 1/);

    const semEscopo = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [mem()], rowCount: 1 } : undefined));
    await expect(criarProposta(semEscopo.q, { tipo: 'reescopo', memoria_ids: [1], justificativa: 'x' }))
      .rejects.toThrow(/escopo_novo/);

    const projMorto = fakeQuery((sql) => {
      if (sql.includes('FROM memories')) return { rows: [mem()], rowCount: 1 };
      if (sql.includes('FROM projects')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await expect(criarProposta(projMorto.q, { tipo: 'reescopo', memoria_ids: [1], escopo_novo: { scope_project_id: 99 }, justificativa: 'x' }))
      .rejects.toThrow(/projeto 99 não existe/);

    const userMorto = fakeQuery((sql) => {
      if (sql.includes('FROM memories')) return { rows: [mem()], rowCount: 1 };
      if (sql.includes('FROM users')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await expect(criarProposta(userMorto.q, { tipo: 'reescopo', memoria_ids: [1], escopo_novo: { scope_user_id: 99 }, justificativa: 'x' }))
      .rejects.toThrow(/usuário 99 não existe/);

    const jaAssim = fakeQuery((sql) =>
      sql.includes('FROM memories') ? { rows: [mem({ scope_project_id: 5 })], rowCount: 1 } : undefined);
    await expect(criarProposta(jaAssim.q, { tipo: 'reescopo', memoria_ids: [1], escopo_novo: { scope_project_id: 5 }, justificativa: 'x' }))
      .rejects.toThrow(/já tem exatamente esse escopo/);
    const jaUniversal = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [mem()], rowCount: 1 } : undefined));
    await expect(criarProposta(jaUniversal.q, { tipo: 'reescopo', memoria_ids: [1], escopo_novo: { universal: true }, justificativa: 'x' }))
      .rejects.toThrow(/já tem exatamente esse escopo/);
  });

  it('níveis 0 e 1 continuam intocáveis também no reescopo', async () => {
    const { q } = fakeQuery((sql) =>
      sql.includes('FROM memories') ? { rows: [mem({ level: 1, code: 'nivel1-mapa' })], rowCount: 1 } : undefined);
    await expect(criarProposta(q, { tipo: 'reescopo', memoria_ids: [1], escopo_novo: { scope_project_id: 5 }, justificativa: 'x' }))
      .rejects.toThrow(/intocáveis/);
  });
});

describe('aplicarProposta reescopo', () => {
  const payload = (escopo: PropostaPayload['escopo_novo']): PropostaPayload => ({
    memoria_ids: [1],
    memorias: [{ id: 1, code: 'fato-a', title: 'Fato A', level: 3, nota: null }],
    escopo_novo: escopo,
    justificativa: 'x',
  });

  it('aplica o escopo de projeto num UPDATE que exige nível >= 2 e zera o escopo de usuário', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('UPDATE memories') ? { rows: [{ code: 'fato-a' }], rowCount: 1 } : undefined);
    const r = await aplicarProposta(q, { tipo: 'reescopo', payload: payload({ scope_project_id: 5, scope_user_id: null }) });
    expect(r).toContain('projeto 5');
    const upd = calls.find((c) => c.sql.includes('UPDATE memories'))!;
    expect(upd.sql).toContain('scope_project_id = $2');
    expect(upd.sql).toContain('scope_user_id = $3');
    expect(upd.sql).toContain('level >= 2');
    expect(upd.params).toEqual([1, 5, null]);
  });

  it('reescopo para universal manda null nos dois escopos', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('UPDATE memories') ? { rows: [{ code: 'fato-a' }], rowCount: 1 } : undefined);
    const r = await aplicarProposta(q, { tipo: 'reescopo', payload: payload({ scope_project_id: null, scope_user_id: null }) });
    expect(r).toContain('universal');
    expect(calls.find((c) => c.sql.includes('UPDATE memories'))!.params).toEqual([1, null, null]);
  });

  it('falha quando a memória sumiu (ou virou intocável) e quando o payload vem sem escopo', async () => {
    const { q } = fakeQuery((sql) => (sql.includes('UPDATE memories') ? { rows: [], rowCount: 0 } : undefined));
    await expect(aplicarProposta(q, { tipo: 'reescopo', payload: payload({ scope_project_id: 5, scope_user_id: null }) }))
      .rejects.toThrow(/não existe mais/);
    await expect(aplicarProposta(q, { tipo: 'reescopo', payload: payload(undefined) })).rejects.toThrow(/escopo_novo/);
    // payload adulterado nunca passa: objeto vazio e os dois escopos juntos são recusados
    await expect(aplicarProposta(q, { tipo: 'reescopo', payload: payload({} as any) })).rejects.toThrow(/escopo_novo/);
    await expect(aplicarProposta(q, { tipo: 'reescopo', payload: payload({ scope_project_id: 5, scope_user_id: 2 } as any) }))
      .rejects.toThrow(/nunca os dois/);
  });
});

describe('ensureCuradoriaTable (migração idempotente do CHECK de tipo)', () => {
  function fakePool() {
    const calls: string[] = [];
    return {
      pool: { query: async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as Pool,
      calls,
    };
  }

  it('cria a tabela já com reescopo e recria o CHECK com DROP IF EXISTS + ADD, sem tocar nas linhas', async () => {
    const { pool, calls } = fakePool();
    await ensureCuradoriaTable(pool);
    const sql = calls.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS curadoria_propostas');
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS curadoria_propostas_tipo_check");
    expect(sql).toContain('ADD CONSTRAINT curadoria_propostas_tipo_check');
    expect(sql).toMatch(/ADD CONSTRAINT[\s\S]*'reescopo'/);
    // o CREATE inline também já traz a lista nova, para banco recém-nascido
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS curadoria_propostas[\s\S]*'reescopo'/);
    // migração não escreve em linhas: nenhum UPDATE/DELETE/INSERT na tabela
    expect(sql).not.toMatch(/UPDATE curadoria_propostas|DELETE FROM curadoria_propostas|INSERT INTO curadoria_propostas/);
  });

  it('rodar duas vezes emite exatamente o mesmo SQL (idempotente por construção)', async () => {
    const a = fakePool();
    await ensureCuradoriaTable(a.pool);
    await ensureCuradoriaTable(a.pool);
    expect(a.calls).toHaveLength(2);
    expect(a.calls[0]).toBe(a.calls[1]);
  });
});

describe('listarProjetos', () => {
  it('devolve id + slug da tabela projects, em ordem estável', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('FROM projects') ? { rows: [{ id: 1, slug: 'orion' }, { id: 2, slug: 'brandspace' }], rowCount: 2 } : undefined);
    const r = await listarProjetos(q);
    expect(r).toEqual([{ id: 1, slug: 'orion' }, { id: 2, slug: 'brandspace' }]);
    expect(calls[0].sql).toContain('SELECT id, slug FROM projects ORDER BY id');
  });
});
