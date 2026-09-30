import { describe, it, expect } from 'vitest';
import { aplicarProposta, criarProposta, type CurQuery, type PropostaPayload } from '../server/curador/proposals.js';

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
  id: 1, code: 'fato-a', title: 'Fato A', level: 4, nota: 10, rewritable: true, ...p,
});

describe('criarProposta', () => {
  it('grava a proposta pendente com snapshot das memórias no payload', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('FROM memories')) return { rows: [mem()], rowCount: 1 };
      if (sql.includes('INSERT INTO curadoria_propostas')) return { rows: [{ id: 7 }], rowCount: 1 };
      return undefined;
    });
    const r = await criarProposta(q, { tipo: 'promocao', memoria_ids: [1], justificativa: 'nota 10 estável' });
    expect(r.id).toBe(7);
    expect(r.payload.memorias).toEqual([{ id: 1, code: 'fato-a', title: 'Fato A', level: 4, nota: 10 }]);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO curadoria_propostas'))!;
    expect(insert.params?.[0]).toBe('promocao');
    expect(String(insert.params?.[1])).toContain('nota 10 estável');
  });

  it('recusa tipo inválido, justificativa vazia e ids inválidos', async () => {
    const { q } = fakeQuery(() => undefined);
    await expect(criarProposta(q, { tipo: 'virar-deus', memoria_ids: [1], justificativa: 'x' })).rejects.toThrow(/tipo inválido/);
    await expect(criarProposta(q, { tipo: 'delecao', memoria_ids: [1], justificativa: '  ' })).rejects.toThrow(/justificativa/);
    await expect(criarProposta(q, { tipo: 'delecao', memoria_ids: [], justificativa: 'x' })).rejects.toThrow(/memoria_ids/);
    await expect(criarProposta(q, { tipo: 'delecao', memoria_ids: [0, -2], justificativa: 'x' })).rejects.toThrow(/inteiros/);
  });

  it('níveis 0 e 1 são intocáveis, memória inexistente é recusada', async () => {
    const { q } = fakeQuery((sql) =>
      sql.includes('FROM memories') ? { rows: [mem({ level: 1, code: 'nivel1-mapa' })], rowCount: 1 } : undefined);
    await expect(criarProposta(q, { tipo: 'delecao', memoria_ids: [1], justificativa: 'x' })).rejects.toThrow(/intocáveis/);

    const vazio = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [], rowCount: 0 } : undefined));
    await expect(criarProposta(vazio.q, { tipo: 'delecao', memoria_ids: [99], justificativa: 'x' })).rejects.toThrow(/inexistente/);
  });

  it('promoção exige exatamente 1 memória nível 4; reescrita exige texto e rewritable; conflito exige 2+', async () => {
    const nivel3 = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [mem({ level: 3, nota: null })], rowCount: 1 } : undefined));
    await expect(criarProposta(nivel3.q, { tipo: 'promocao', memoria_ids: [1], justificativa: 'x' })).rejects.toThrow(/nível 4/);

    const duas = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [mem(), mem({ id: 2, code: 'fato-b' })], rowCount: 2 } : undefined));
    await expect(criarProposta(duas.q, { tipo: 'promocao', memoria_ids: [1, 2], justificativa: 'x' })).rejects.toThrow(/exatamente 1/);

    const naoReescrevivel = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [mem({ rewritable: false })], rowCount: 1 } : undefined));
    await expect(criarProposta(naoReescrevivel.q, { tipo: 'reescrita', memoria_ids: [1], texto: 'novo', justificativa: 'x' })).rejects.toThrow(/reescrevível/);

    const ok = fakeQuery((sql) => (sql.includes('FROM memories') ? { rows: [mem()], rowCount: 1 } : undefined));
    await expect(criarProposta(ok.q, { tipo: 'reescrita', memoria_ids: [1], justificativa: 'x' })).rejects.toThrow(/texto/);
    await expect(criarProposta(ok.q, { tipo: 'conflito', memoria_ids: [1], justificativa: 'x' })).rejects.toThrow(/2 memórias/);
  });
});

describe('aplicarProposta', () => {
  const payload = (p: Partial<PropostaPayload> = {}): PropostaPayload => ({
    memoria_ids: [1], memorias: [{ id: 1, code: 'fato-a', title: 'Fato A', level: 4, nota: 10 }], ...p,
  });

  it('promocao: nível 4 vira 3 com nota NULL, mantendo escopo (o UPDATE não toca em escopo)', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('UPDATE memories') ? { rows: [{ code: 'fato-a' }], rowCount: 1 } : undefined);
    const r = await aplicarProposta(q, { tipo: 'promocao', payload: payload() });
    expect(r).toContain('promovida');
    const upd = calls.find((c) => c.sql.includes('UPDATE memories'))!;
    expect(upd.sql).toContain('level = 3');
    expect(upd.sql).toContain('nota = NULL');
    expect(upd.sql).toContain('level = 4'); // revalida: só promove quem AINDA é nível 4
    expect(upd.sql).not.toMatch(/scope_project_id|scope_user_id/); // escopo intacto
  });

  it('promocao falha se a memória não é mais nível 4 (estado mudou desde a proposta)', async () => {
    const { q } = fakeQuery((sql) => (sql.includes('UPDATE memories') ? { rows: [], rowCount: 0 } : undefined));
    await expect(aplicarProposta(q, { tipo: 'promocao', payload: payload() })).rejects.toThrow(/não é mais/);
  });

  it('reescrita: grava body_md novo e last_rewritten_at, só em memória rewritable de nível 2+', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('UPDATE memories') ? { rows: [{ code: 'fato-a' }], rowCount: 1 } : undefined);
    const r = await aplicarProposta(q, { tipo: 'reescrita', payload: payload({ texto: '# Novo corpo' }) });
    expect(r).toContain('reescrita');
    const upd = calls.find((c) => c.sql.includes('UPDATE memories'))!;
    expect(upd.sql).toContain('body_md = $2');
    expect(upd.sql).toContain('last_rewritten_at = now()');
    expect(upd.sql).toContain('level >= 2');
    expect(upd.sql).toContain('rewritable');
    expect(upd.params?.[1]).toBe('# Novo corpo');
    await expect(aplicarProposta(q, { tipo: 'reescrita', payload: payload({ texto: '  ' }) })).rejects.toThrow(/sem texto/);
  });

  it('reescrita: resumo novo vai junto quando vem no payload; sem ele o resumo antigo fica', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('UPDATE memories') ? { rows: [{ code: 'fato-a' }], rowCount: 1 } : undefined);
    await aplicarProposta(q, { tipo: 'reescrita', payload: payload({ texto: 'corpo', resumo: 'resumo novo' }) });
    await aplicarProposta(q, { tipo: 'reescrita', payload: payload({ texto: 'corpo' }) });
    const [com, sem] = calls.filter((c) => c.sql.includes('UPDATE memories'));
    expect(com.sql).toContain('summary = COALESCE($3, summary)');
    expect(com.params?.[2]).toBe('resumo novo');
    expect(sem.params?.[2]).toBeNull();
  });

  it('delecao: DELETE que nunca encosta em nível < 2, mesmo com payload errado', async () => {
    const { q, calls } = fakeQuery((sql) =>
      sql.includes('DELETE FROM memories') ? { rows: [{ code: 'fato-a' }], rowCount: 1 } : undefined);
    const r = await aplicarProposta(q, { tipo: 'delecao', payload: payload() });
    expect(r).toContain('fato-a');
    const del = calls.find((c) => c.sql.includes('DELETE FROM memories'))!;
    expect(del.sql).toContain('level >= 2');
  });

  it('conflito: não toca nas memórias, só descreve a resolução', async () => {
    const { q, calls } = fakeQuery(() => undefined);
    const r = await aplicarProposta(q, { tipo: 'conflito', payload: payload({ memoria_ids: [1, 2] }) });
    expect(r).toContain('resolvido');
    expect(calls.some((c) => c.sql.includes('UPDATE memories') || c.sql.includes('DELETE'))).toBe(false);
  });
});
