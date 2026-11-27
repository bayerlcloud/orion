import { describe, expect, it } from 'vitest';
import { cacheFora, decidirFora, foraDaSessao, foraEmVoo, limparResumo, montarEntrada, FORA_AUSENCIA_MIN_MS } from '../server/claude/fora.js';

const agora = new Date('2026-11-27T12:00:00Z');
const antes = (ms: number) => new Date(agora.getTime() - ms);

describe('decidirFora', () => {
  it('nada sem visto_em (nunca abriu) ou sem result novo', () => {
    expect(decidirFora({ vistoEm: null, ultimoResultSeq: 10, cache: null, now: agora })).toEqual({ acao: 'nada' });
    expect(decidirFora({ vistoEm: antes(3 * 3600e3), ultimoResultSeq: null, cache: null, now: agora })).toEqual({ acao: 'nada' });
  });
  it('nada se viu há menos de 30 min, mesmo com result novo', () => {
    expect(decidirFora({ vistoEm: antes(FORA_AUSENCIA_MIN_MS - 1000), ultimoResultSeq: 10, cache: null, now: agora })).toEqual({ acao: 'nada' });
  });
  it('gera quando viu há mais de 30 min e há result novo', () => {
    expect(decidirFora({ vistoEm: antes(FORA_AUSENCIA_MIN_MS + 1000), ultimoResultSeq: 42, cache: null, now: agora })).toEqual({ acao: 'gerar', ateSeq: 42 });
  });
  it('cache com o mesmo ate_seq vale mesmo com visto_em recente; ate_seq antigo regenera', () => {
    const cache = { ate_seq: 42, texto: 'feito: x', gerado_em: '2026-11-27T11:00:00Z' };
    expect(decidirFora({ vistoEm: antes(1000), ultimoResultSeq: 42, cache, now: agora })).toEqual({ acao: 'cache', fora: { texto: 'feito: x', ate_seq: 42 } });
    expect(decidirFora({ vistoEm: antes(2 * FORA_AUSENCIA_MIN_MS), ultimoResultSeq: 50, cache, now: agora })).toEqual({ acao: 'gerar', ateSeq: 50 });
  });
  it('cache com texto vazio (modelo falhou) não mostra nem tenta de novo', () => {
    expect(decidirFora({ vistoEm: antes(2 * FORA_AUSENCIA_MIN_MS), ultimoResultSeq: 42, cache: { ate_seq: 42, texto: '', gerado_em: '' }, now: agora })).toEqual({ acao: 'nada' });
  });
});

describe('montarEntrada', () => {
  const ev = (type: string, content: unknown) => ({ type, payload: { message: { content } } });
  it('só texto do assistant, sem tool_use, thinking, user ou result', () => {
    const texto = montarEntrada([
      ev('assistant', [{ type: 'thinking', thinking: 'pensando' }, { type: 'text', text: 'Vou olhar o arquivo.' }, { type: 'tool_use', name: 'Read', input: { path: 'x' } }]),
      ev('user', [{ type: 'tool_result', content: 'conteudo do arquivo' }]),
      { type: 'result', payload: { result: 'resumo do SDK' } },
      ev('assistant', [{ type: 'text', text: 'Pronto, corrigi o bug.' }]),
    ]);
    expect(texto).toBe('Vou olhar o arquivo.\nPronto, corrigi o bug.');
  });
  it('corta pelo fim quando passa do teto', () => {
    const texto = montarEntrada([ev('assistant', [{ type: 'text', text: 'a'.repeat(50) + 'FIM' }])], 10);
    expect(texto).toBe('aaaaaaaFIM');
    expect(texto.length).toBe(10);
  });
  it('payload sem content em array não quebra', () => {
    expect(montarEntrada([{ type: 'assistant', payload: { message: { content: 'texto solto' } } }, { type: 'assistant', payload: null }])).toBe('');
  });
});

describe('limparResumo', () => {
  it('no máximo 3 linhas, sem vazias nem marcadores', () => {
    expect(limparResumo('\n- feito: a\n\n* pendente: b\n• precisa de você: c\nquarta linha\n')).toBe('feito: a\npendente: b\nprecisa de você: c');
  });
  it('vazio continua vazio', () => {
    expect(limparResumo('  \n ')).toBe('');
  });
});

/** Pool falso: tabela de vistas com uma linha, eventos de uma sessão, e o UPDATE do cache capturado. */
function poolFalso(vista: { visto_em: Date; resumo: unknown } | null, resultSeq: number | null, eventos: unknown[]) {
  const updates: unknown[][] = [];
  return {
    updates,
    pool: { query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM claude_session_vistas')) return { rows: vista ? [vista] : [] };
      if (sql.includes("type = 'result'")) return { rows: [{ seq: resultSeq }] };
      if (sql.includes("type = 'assistant'")) return { rows: eventos };
      if (sql.startsWith('UPDATE claude_session_vistas')) { updates.push(params); return { rows: [] }; }
      throw new Error(`sql inesperado: ${sql.slice(0, 60)}`);
    } } as any,
  };
}
const token = async () => null;

describe('foraDaSessao (geração em segundo plano)', () => {
  const vistoOntem = { visto_em: new Date(Date.now() - 20 * 3600e3), resumo: null };
  const eventos = [{ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Migrei o banco e rodei os testes.' }] } } }];

  it('responde pendente na hora; o modelo (mock) roda depois e o cache fica gravado', async () => {
    const { pool, updates } = poolFalso(vistoOntem, 77, eventos);
    const chamadas: string[] = [];
    const resumir = async (entrada: string) => { chamadas.push(entrada); return 'feito: migração do banco\npendente: deploy'; };
    expect(await foraDaSessao(pool, 'g1', 1, { gerar: true, token, resumir })).toEqual({ pendente: true, ate_seq: 77 });
    expect(updates).toEqual([]);
    await foraEmVoo('g1', 1);
    expect(chamadas).toEqual(['Migrei o banco e rodei os testes.']);
    expect(JSON.parse(updates[0][2] as string)).toMatchObject({ ate_seq: 77, texto: 'feito: migração do banco\npendente: deploy' });
    expect(foraEmVoo('g1', 1)).toBeUndefined();
  });
  it('segunda abertura durante o voo não chama o modelo de novo (e reconexão sem gerar também vê pendente)', async () => {
    const { pool } = poolFalso(vistoOntem, 77, eventos);
    let solta!: () => void; let chamou = 0;
    const resumir = async () => { chamou++; await new Promise<void>(r => { solta = r; }); return 'feito: x'; };
    expect(await foraDaSessao(pool, 'g2', 1, { gerar: true, token, resumir })).toEqual({ pendente: true, ate_seq: 77 });
    expect(await foraDaSessao(pool, 'g2', 1, { gerar: true, token, resumir })).toEqual({ pendente: true, ate_seq: 77 });
    expect(await foraDaSessao(pool, 'g2', 1, { gerar: false, token, resumir })).toEqual({ pendente: true, ate_seq: 77 });
    expect(await cacheFora(pool, 'g2', 1)).toEqual({ pendente: true });
    solta(); await foraEmVoo('g2', 1);
    expect(chamou).toBe(1);
  });
  it('sem gerar (reconexão, script) e sem voo: não chama o modelo e devolve null', async () => {
    const { pool, updates } = poolFalso(vistoOntem, 77, eventos);
    let chamou = false;
    expect(await foraDaSessao(pool, 'g3', 1, { gerar: false, token, resumir: async () => { chamou = true; return 'x'; } })).toBeNull();
    expect(chamou).toBe(false);
    expect(updates).toEqual([]);
  });
  it('cache válido volta direto, mesmo sem gerar', async () => {
    const { pool } = poolFalso({ visto_em: new Date(), resumo: { ate_seq: 77, texto: 'feito: tudo', gerado_em: 'x' } }, 77, eventos);
    expect(await foraDaSessao(pool, 'g4', 1, { gerar: false, token, resumir: async () => 'não' })).toEqual({ texto: 'feito: tudo', ate_seq: 77 });
  });
  it('modelo falhou (texto vazio): cache vazio gravado para não insistir; /fora devolve null', async () => {
    const { pool, updates } = poolFalso(vistoOntem, 77, eventos);
    expect(await foraDaSessao(pool, 'g5', 1, { gerar: true, token, resumir: async () => '' })).toEqual({ pendente: true, ate_seq: 77 });
    await foraEmVoo('g5', 1);
    expect(JSON.parse(updates[0][2] as string)).toMatchObject({ ate_seq: 77, texto: '' });
  });
  it('nunca abriu: null sem consultar eventos', async () => {
    const { pool } = poolFalso(null, 77, eventos);
    expect(await foraDaSessao(pool, 'g6', 1, { gerar: true, token, resumir: async () => 'x' })).toBeNull();
  });
});

describe('cacheFora (GET /fora, só leitura)', () => {
  it('com cache: devolve texto e ate_seq', async () => {
    const { pool } = poolFalso({ visto_em: new Date(), resumo: { ate_seq: 9, texto: 'feito: a', gerado_em: 'x' } }, 9, []);
    expect(await cacheFora(pool, 'c1', 1)).toEqual({ texto: 'feito: a', ate_seq: 9 });
  });
  it('sem cache, cache vazio ou sem linha: null', async () => {
    expect(await cacheFora(poolFalso({ visto_em: new Date(), resumo: null }, 9, []).pool, 'c2', 1)).toBeNull();
    expect(await cacheFora(poolFalso({ visto_em: new Date(), resumo: { ate_seq: 9, texto: '', gerado_em: 'x' } }, 9, []).pool, 'c3', 1)).toBeNull();
    expect(await cacheFora(poolFalso(null, 9, []).pool, 'c4', 1)).toBeNull();
  });
});
