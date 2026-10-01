import { describe, it, expect } from 'vitest';
import { buscarHistorico, materializarTurnos, separarAutor, textoDoTurno, type HQuery } from '../server/memories/historico.js';

type Chamada = { sql: string; params?: unknown[] };
function fakeQuery(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  const calls: Chamada[] = [];
  const q: HQuery = async (sql, params) => { calls.push({ sql, params }); return responder(sql, params) ?? { rows: [], rowCount: 0 }; };
  return { q, calls };
}

describe('separarAutor / textoDoTurno', () => {
  it('tira o prefixo [Nome] e guarda o nome', () => {
    expect(separarAutor('[Guilherme] usa o conector do Google')).toEqual({ nome: 'Guilherme', texto: 'usa o conector do Google' });
    expect(separarAutor('sem prefixo')).toEqual({ nome: null, texto: 'sem prefixo' });
  });
  it('embedding leva quem + começo do pedido + começo da resposta', () => {
    expect(textoDoTurno('Laís', 'pedido', 'resposta')).toBe('Laís: pedido\nresposta');
    expect(textoDoTurno(null, 'x'.repeat(2000), 'y')).toHaveLength(1500 + 1 + 1);
  });
});

describe('materializarTurnos', () => {
  it('só turnos terminados e novos; autor pelo nome; cutucão do Orion fica de fora; resposta é só texto do assistente', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes("e.type = 'user_prompt'")) {
        return { rows: [
          { evento_id: 10, session_id: 's1', seq: 3, ts: new Date('2026-10-01T10:00:00Z'), prompt: '[Guilherme] conector do Google Search por API', project_id: 5, user_id: 1 },
          { evento_id: 12, session_id: 's1', seq: 9, ts: new Date('2026-10-01T10:05:00Z'), prompt: '[Orion] Seu turno terminou sem mensagem', project_id: 5, user_id: 1 },
        ], rowCount: 2 };
      }
      if (sql.includes('SELECT id, name FROM users')) return { rows: [{ id: 3, name: 'Guilherme' }], rowCount: 1 };
      if (sql.includes('string_agg')) return { rows: [{ resposta: 'Decidido: via API oficial.' }], rowCount: 1 };
      if (sql.includes('INSERT INTO historico_turnos')) return { rows: [{ id: 77 }], rowCount: 1 };
      return undefined;
    });
    const emb = async () => [0.1, 0.2];
    const n = await materializarTurnos(q, { embedder: emb });
    expect(n).toBe(1);
    const sel = calls[0];
    expect(sel.sql).toContain('e.id > (SELECT COALESCE(MAX(evento_id), 0) FROM historico_turnos)');
    expect(sel.sql).toContain("r.type = 'result' AND r.seq > e.seq");
    const ins = calls.find((c) => c.sql.includes('INSERT INTO historico_turnos'))!;
    expect(ins.params).toEqual([10, 's1', 3, 5, 3, 'Guilherme', new Date('2026-10-01T10:00:00Z'), 'conector do Google Search por API', 'Decidido: via API oficial.']);
    expect(calls.filter((c) => c.sql.includes('INSERT INTO historico_turnos'))).toHaveLength(1); // o [Orion] não entra
  });

  it('sem embedder (null) não toca na coluna embedding; sem prompt novo devolve 0', async () => {
    const { q, calls } = fakeQuery((sql) => (sql.includes("e.type = 'user_prompt'") ? { rows: [], rowCount: 0 } : undefined));
    expect(await materializarTurnos(q, { embedder: null })).toBe(0);
    expect(calls.some((c) => c.sql.includes('SET embedding'))).toBe(false);
  });
});

describe('buscarHistorico', () => {
  const linha = { id: 1, ts: new Date('2026-10-01T14:30:00Z'), autor_nome: 'Guilherme', sessao_id: 's1', prompt: 'conector do Google', resposta: 'via API', projeto: 'trackingmachine', sessao: 'TM conector' };

  it('filtra pelo projeto da sessão por padrão, pessoa e desde opcionais; devolve quem, quando, trechos', async () => {
    const { q, calls } = fakeQuery((sql) => (sql.includes('plainto_tsquery') ? { rows: [linha], rowCount: 1 } : undefined));
    const r = await buscarHistorico(q, { projectId: 5 }, { consulta: 'google', pessoa: 'gui', desde: '2026-09-30' }, async () => [0]);
    expect(calls[0].params).toEqual(['google', 5, '%gui%', '2026-09-30']);
    expect(r).toEqual([{ quando: '2026-10-01 14:30', quem: 'Guilherme', projeto: 'trackingmachine', sessao: 'TM conector', sessao_id: 's1', pedido: 'conector do Google', resposta: 'via API' }]);
  });

  it('todos_projetos tira o filtro de projeto; sem nada no full-text cai no ILIKE; data inválida é recusada', async () => {
    const { q, calls } = fakeQuery((sql) => (sql.includes('ILIKE $1') ? { rows: [linha], rowCount: 1 } : undefined));
    const r = await buscarHistorico(q, { projectId: 5 }, { consulta: 'x', todos_projetos: true }, async () => [0]);
    expect(calls[0].params?.[1]).toBeNull();
    expect(r).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes('ILIKE $1'))).toBe(true);
    await expect(buscarHistorico(q, { projectId: 5 }, { consulta: 'x', desde: 'ontem' })).rejects.toThrow(/desde/);
    await expect(buscarHistorico(q, { projectId: 5 }, { consulta: ' ' })).rejects.toThrow(/consulta/);
  });
});
