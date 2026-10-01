import { describe, it, expect } from 'vitest';
import { atualizarMemoria, buscarMemorias, salvarMemoria, type MemQuery, type MemoryToolCtx } from '../server/claude/memoryTool.js';
import type { Embedder } from '../server/memories/embed.js';

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

/** Mesmo responder, mas com a coluna embedding "existindo" (pós-migração pgvector). */
function comColuna(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  return fakeQuery((sql, params) => {
    if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }], rowCount: 1 };
    return responder(sql, params);
  });
}

const embedderFixo = (vetor: number[]): Embedder & { textos: string[] } => {
  const fn = (async (texto: string) => {
    fn.textos.push(texto);
    return vetor;
  }) as Embedder & { textos: string[] };
  fn.textos = [];
  return fn;
};

const embedderQuebrado: Embedder = async () => {
  throw new Error('modelo indisponível');
};

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
    expect(r).toEqual([{ code: 'orion-coletor-cpu-sem-iowait', nivel: 4, nota: 6, titulo: 'Coletor não soma iowait', resumo: 'resumo', corpo: 'corpo', escopo: 'universal', autor: null, quando: null }]);
    // Filtro de escopo da sessão (universal + projeto + pessoa), só memória ativa, $5 = todos_projetos
    expect(calls[0].sql).toContain("m.estado = 'ativa'");
    expect(calls[0].params).toEqual(['iowait cpu', null, 1, 1, false]);

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

  it('sem a coluna embedding (pré-migração) não roda a query vetorial', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('plainto_tsquery') && sql.trimStart().startsWith('SELECT')) return { rows: [memRow({ level: 3, nota: null })], rowCount: 1 };
      return undefined;
    });
    const emb = embedderFixo([0.5]);
    const r = await buscarMemorias(q, ctx, { consulta: 'iowait' }, emb);
    expect(r).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes('<=>'))).toBe(false);
    expect(emb.textos).toEqual([]); // nem embeda: feature-detect vem antes do modelo
  });
});

describe('buscar híbrida (pós-migração pgvector)', () => {
  const linha = (id: number, code: string) => memRow({ id, code, level: 3, nota: null });

  it('funde full-text e vetorial por reciprocal rank fusion (quem aparece nas duas sobe)', async () => {
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('<=>')) return { rows: [linha(3, 'c'), linha(1, 'a')], rowCount: 2 };
      if (sql.includes('plainto_tsquery') && sql.trimStart().startsWith('SELECT')) {
        return { rows: [linha(1, 'a'), linha(2, 'b')], rowCount: 2 };
      }
      return undefined;
    });
    const emb = embedderFixo([0.1, 0.2]);
    const r = await buscarMemorias(q, ctx, { consulta: 'iowait no coletor' }, emb);
    // a: 1/61 + 1/62; c: 1/61; b: 1/62 -> a, c, b
    expect(r.map((m) => m.code)).toEqual(['a', 'c', 'b']);

    const vetorial = calls.find((c) => c.sql.includes('<=>'))!;
    expect(vetorial.sql).toContain('embedding IS NOT NULL');
    expect(vetorial.sql).toContain('level BETWEEN 2 AND 4');
    expect(vetorial.params?.[0]).toBe('[0.1,0.2]'); // literal do pgvector
    expect(vetorial.params?.[1]).toBeNull();
    expect(emb.textos).toEqual(['iowait no coletor']); // o embedder recebe a consulta crua (o prefixo e5 "query: " vive em embedConsulta)

    // o rastro cobre as três memórias fundidas
    const rastro = calls.find((c) => c.sql.includes('last_accessed_session'))!;
    expect(rastro.params?.[0]).toEqual([1, 3, 2]);
  });

  it('embedder falhando não derruba a busca: segue no full-text puro', async () => {
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('plainto_tsquery') && sql.trimStart().startsWith('SELECT')) return { rows: [linha(1, 'a')], rowCount: 1 };
      return undefined;
    });
    const r = await buscarMemorias(q, ctx, { consulta: 'iowait' }, embedderQuebrado);
    expect(r.map((m) => m.code)).toEqual(['a']);
    expect(calls.some((c) => c.sql.includes('<=>'))).toBe(false);
  });

  it('full-text vazio mas vetorial achando: não cai no ILIKE', async () => {
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('<=>')) return { rows: [linha(9, 'so-vetorial')], rowCount: 1 };
      if (sql.trimStart().startsWith('SELECT')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const r = await buscarMemorias(q, ctx, { consulta: 'sinônimo que o tsquery não pega' }, embedderFixo([1]));
    expect(r.map((m) => m.code)).toEqual(['so-vetorial']);
    expect(calls.some((c) => c.sql.includes('ILIKE'))).toBe(false);
  });
});

describe('salvar', () => {
  it('recusa níveis 0 e 1 com mensagem clara (escada de escrita)', async () => {
    const { q } = fakeQuery(() => undefined);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 0 })).rejects.toThrow(/Danilo/);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 1 })).rejects.toThrow(/gerador/);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 7 })).rejects.toThrow(/2 a 4/);
  });

  it('sem nível vira micro-fato (4) com nota 5, e HERDA o projeto da sessão como escopo padrão', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const r = await salvarMemoria(q, ctx, { titulo: 'VNC exposto na c2', corpo: 'fechar a porta' });
    expect(r).toEqual({ salva: true, code: 'vnc-exposto-na-c2', nivel: 4, nota: 5 });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    // ... + autor (quem mandou o turno; sem autorId cai no criador), sessão de origem e origem 'tool'
    expect(insert.params).toEqual(['vnc-exposto-na-c2', 'VNC exposto na c2', '', 'fechar a porta', 4, 5, [], 1, null, 1, 'sess-1', 'tool']);
  });

  it('universal: true grava sem escopo nenhum (exceção consciente)', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await salvarMemoria(q, ctx, { titulo: 'Vale pra tudo', corpo: 'c', universal: true });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.params?.[7]).toBeNull(); // scope_project_id
    expect(insert.params?.[8]).toBeNull(); // scope_user_id
  });

  it('sobre_pessoa: true grava o criador da sessão como escopo de usuário (e sai do projeto)', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await salvarMemoria(q, ctx, { titulo: 'Danilo prefere pt-br', corpo: 'c', nivel: 2, sobre_pessoa: true });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.params?.[7]).toBeNull(); // scope_project_id
    expect(insert.params?.[8]).toBe(1); // scope_user_id = criador (ctx.userId)
  });

  it('sessão neutra (sem projeto) e sem flags: nasce na pessoa, nunca universal por acaso', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await salvarMemoria(q, { ...ctx, projectId: null }, { titulo: 'x', corpo: 'y' });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.params?.[7]).toBeNull();
    expect(insert.params?.[8]).toBe(ctx.userId);
    await salvarMemoria(q, { ...ctx, projectId: null }, { titulo: 'x', corpo: 'y', universal: true });
    const universal = calls.filter((c) => c.sql.includes('INSERT INTO memories'))[1];
    expect(universal.params?.[8]).toBeNull();
  });

  it('escopo explícito continua valendo mais que o padrão da sessão', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', nivel: 3, escopo_projeto_id: 7, escopo_usuario_id: 9 });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.params?.[7]).toBe(7);
    expect(insert.params?.[8]).toBe(9);
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

  it('com a coluna embedding, a memória nasce embedada (passage: título + resumo + corpo)', async () => {
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const emb = embedderFixo([0.1, 0.2, 0.3]);
    await salvarMemoria(q, ctx, { titulo: 'Título', corpo: 'corpo md', resumo: 'resumo' }, emb);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.sql).toContain('embedding');
    expect(insert.sql).toContain('::vector');
    expect(insert.params?.[12]).toBe('[0.1,0.2,0.3]');
    expect(emb.textos).toEqual(['Título\nresumo\ncorpo md']);
  });

  it('embedder quebrado não impede o salvar: grava sem embedding (o backfill cobre)', async () => {
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const r = await salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y' }, embedderQuebrado);
    expect(r).toMatchObject({ salva: true, code: 'x' });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.sql).not.toContain('embedding');
    expect(insert.params).toHaveLength(12);
  });

  it('escopo plataforma grava universal; escopo pessoa grava no criador; autorId vira autor', async () => {
    const { q, calls } = fakeQuery((sql) => (sql.includes('WHERE code = $1') ? { rows: [], rowCount: 0 } : undefined));
    await salvarMemoria(q, { ...ctx, autorId: 3 }, { titulo: 'Publicar é pela fila', corpo: 'c', nivel: 2, escopo: 'plataforma' });
    let insert = calls.filter((c) => c.sql.includes('INSERT INTO memories')).at(-1)!;
    expect(insert.params?.slice(7, 10)).toEqual([null, null, 3]); // sem escopo, autor = quem mandou o turno
    await salvarMemoria(q, ctx, { titulo: 'Gosta de resposta curta', corpo: 'c', nivel: 2, escopo: 'pessoa' });
    insert = calls.filter((c) => c.sql.includes('INSERT INTO memories')).at(-1)!;
    expect(insert.params?.slice(7, 9)).toEqual([null, 1]);
    await expect(salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y', escopo: 'global' as any })).rejects.toThrow(/escopo/);
  });

  it('duplicata (cosseno >= 0,95 no mesmo escopo) não grava e aponta o code; forcar grava; parecida só avisa', async () => {
    let sim = 0.97;
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      if (sql.includes('IS NOT DISTINCT FROM')) return { rows: [{ code: 'ja-existe', title: 'Já existe', sim }], rowCount: 1 };
      return undefined;
    });
    const emb = embedderFixo([0.5]);
    const r = await salvarMemoria(q, ctx, { titulo: 'Quase igual', corpo: 'c' }, emb);
    expect(r).toMatchObject({ salva: false, parecida: 'ja-existe', similaridade: 0.97 });
    expect(calls.some((c) => c.sql.includes('INSERT INTO memories'))).toBe(false);
    const dedupe = calls.find((c) => c.sql.includes('IS NOT DISTINCT FROM'))!;
    expect(dedupe.params).toEqual(['[0.5]', 1, null]); // mesmo escopo da memória nova: projeto 1, sem pessoa

    const forcada = await salvarMemoria(q, ctx, { titulo: 'Quase igual', corpo: 'c', forcar: true }, emb);
    expect(forcada).toMatchObject({ salva: true, code: 'quase-igual' });

    sim = 0.92;
    const parecida = await salvarMemoria(q, ctx, { titulo: 'Parecida', corpo: 'c' }, emb);
    expect(parecida).toMatchObject({ salva: true, code: 'parecida' });
    expect((parecida as any).aviso).toContain('ja-existe');
  });
  it('sem a coluna embedding, o INSERT nem menciona a coluna (pré-migração, zero erro)', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const emb = embedderFixo([1]);
    await salvarMemoria(q, ctx, { titulo: 'x', corpo: 'y' }, emb);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.sql).not.toContain('embedding');
    expect(emb.textos).toEqual([]);
  });
});

describe('atualizar', () => {
  const linha = (level: number) => ({ id: 7, code: 'x', title: 't', summary: 's', body_md: 'b', level });

  it('nível 4: muda na hora, guarda o corpo anterior e reembeda', async () => {
    const { q, calls } = comColuna((sql) => {
      if (sql.includes('SELECT id, code, title, summary, body_md, level FROM memories')) return { rows: [linha(4)], rowCount: 1 };
      if (sql.includes('UPDATE memories SET')) return { rows: [{ title: 't', summary: 's', body_md: 'novo' }], rowCount: 1 };
      return undefined;
    });
    const emb = embedderFixo([0.9]);
    const r = await atualizarMemoria(q, ctx, { code: 'x', corpo: 'novo' }, emb);
    expect(r).toEqual({ atualizada: true, code: 'x', nivel: 4, campos: ['corpo'] });
    const up = calls.find((c) => c.sql.includes('UPDATE memories SET') && c.sql.includes('corpo_anterior'))!;
    expect(up.params).toEqual([7, null, null, 'novo', null, null]);
    expect(emb.textos).toEqual(['t\ns\nnovo']);
    expect(calls.some((c) => c.sql.includes('SET embedding'))).toBe(true);
  });

  it('estado substituida aposenta sem reembedar; nível 3 vira proposta (reescrita ou deleção)', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('SELECT id, code, title, summary, body_md, level FROM memories')) return { rows: [linha(4)], rowCount: 1 };
      if (sql.includes('UPDATE memories SET')) return { rows: [{ title: 't', summary: 's', body_md: 'b' }], rowCount: 1 };
      return undefined;
    });
    const r = await atualizarMemoria(q, ctx, { code: 'x', estado: 'substituida' });
    expect(r).toEqual({ atualizada: true, code: 'x', nivel: 4, campos: ['estado'] });
    expect(calls.some((c) => c.sql.includes('information_schema'))).toBe(false);

    const { q: q3, calls: c3 } = fakeQuery((sql) => {
      if (sql.includes('SELECT id, code, title, summary, body_md, level FROM memories')) return { rows: [linha(3)], rowCount: 1 };
      if (sql.includes('FROM memories WHERE id = ANY')) return { rows: [{ id: 7, code: 'x', title: 't', level: 3, nota: null, rewritable: true }], rowCount: 1 };
      if (sql.includes('INSERT INTO curadoria_propostas')) return { rows: [{ id: 55 }], rowCount: 1 };
      return undefined;
    });
    const p = await atualizarMemoria(q3, { ...ctx, autorId: 2 }, { code: 'x', corpo: 'novo', motivo: 'mudou o fluxo' });
    expect(p).toMatchObject({ atualizada: false, code: 'x', proposta: 55, tipo: 'reescrita' });
    const ins = c3.find((c) => c.sql.includes('INSERT INTO curadoria_propostas'))!;
    expect(ins.params?.[0]).toBe('reescrita');
    expect(String(ins.params?.[1])).toContain('mudou o fluxo');
    expect(c3.some((c) => c.sql.includes('UPDATE memories SET'))).toBe(false); // decisão fechada não muda direto
    const d = await atualizarMemoria(q3, ctx, { code: 'x', estado: 'substituida' });
    expect(d).toMatchObject({ atualizada: false, tipo: 'delecao' });
  });

  it('recusa níveis 0 e 1, code inexistente e chamada sem campo', async () => {
    const { q } = fakeQuery((sql) => (sql.includes('SELECT id, code, title') ? { rows: [linha(1)], rowCount: 1 } : undefined));
    await expect(atualizarMemoria(q, ctx, { code: 'x', corpo: 'c' })).rejects.toThrow(/níveis 0 e 1/);
    const { q: vazio } = fakeQuery(() => undefined);
    await expect(atualizarMemoria(vazio, ctx, { code: 'nao-existe', corpo: 'c' })).rejects.toThrow(/não existe/);
    await expect(atualizarMemoria(vazio, ctx, { code: 'x' })).rejects.toThrow(/ao menos um campo/);
    await expect(atualizarMemoria(vazio, ctx, { code: 'x', estado: 'morta' as any })).rejects.toThrow(/estado/);
  });
});
