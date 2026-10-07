import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { classificar, makeLayaHook } from '../server/claude/layaHook.js';

const opts = { signal: new AbortController().signal };

function fakePool(settingsValue: string | null) {
  const inserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT value FROM settings')) return { rows: settingsValue === null ? [] : [{ value: settingsValue }], rowCount: settingsValue === null ? 0 : 1 };
      if (sql.includes('SELECT slug, name FROM projects')) return { rows: [{ slug: 'fisioexpert', name: 'FisioExpert' }], rowCount: 1 };
      if (sql.includes('INSERT INTO triagem_sombra')) { inserts.push(params ?? []); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, inserts };
}

const input = (prompt: string): UserPromptSubmitHookInput => ({ hook_event_name: 'UserPromptSubmit', prompt } as UserPromptSubmitHookInput);

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('makeLayaHook (wrapper síncrono: nunca espera a classificação)', () => {
  it('devolve {} na hora, mesmo com o fetch pendente (fire-and-forget, spec: "o hook não espera a gravação")', async () => {
    const { pool } = fakePool('1');
    let resolveFetch: (v: unknown) => void = () => {};
    vi.mocked(fetch).mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
    const hook = makeLayaHook(pool, 's1');
    const r = await hook(input('[Guilherme] oi'), undefined, opts);
    expect(r).toEqual({});
    resolveFetch({ ok: true, json: async () => ({ answers: {} }) });
  });

  it('pula mensagens do próprio Orion ([Orion] ...), nunca chama o Laya pra elas', async () => {
    const { pool } = fakePool('1');
    const hook = makeLayaHook(pool, 's1');
    await hook(input('[Orion] Seu turno terminou sem mensagem'), undefined, opts);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('não lança quando hook_event_name não é UserPromptSubmit', async () => {
    const { pool } = fakePool('1');
    const hook = makeLayaHook(pool, 's1');
    expect(await hook({ hook_event_name: 'Stop' } as any, undefined, opts)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('classificar (o trabalho de fato, testado direto — makeLayaHook não espera por ele)', () => {
  it('não chama o Laya quando laya_ativo está desligado', async () => {
    const { pool } = fakePool(null);
    await classificar(pool, 's1', '[Guilherme] oi');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('manda o contrato real do Laya: state.body + questions como objeto com type/instructions/criteria', async () => {
    const { pool } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ answers: {} }) } as Response);
    await classificar(pool, 's1', '[Guilherme] oi');
    const [url, reqInit] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765/v1/systemone');
    const body = JSON.parse(String((reqInit as RequestInit).body));
    expect(body.state).toEqual({ body: 'oi' });
    expect(body.questions.complexidade).toMatchObject({ type: 'score' });
    expect(Array.isArray(body.questions.complexidade.criteria)).toBe(true);
    expect(body.questions.complexidade.criteria).toHaveLength(4);
    expect(body.questions.precisa_memoria).toMatchObject({ type: 'noul' });
    expect(body.questions.injecao).toMatchObject({ type: 'noul' });
    expect(body.questions.projeto).toMatchObject({ type: 'choice' });
    expect(body.questions.projeto.criteria).toMatchObject({ fisioexpert: 'FisioExpert', geral: expect.any(String) });
  });

  it('remove o prefixo [Nome] e corta em 2000 caracteres antes de mandar pro Laya', async () => {
    const { pool } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ answers: {} }) } as Response);
    await classificar(pool, 's1', '[Guilherme] ' + 'x'.repeat(3000));
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body.state.body.startsWith('[')).toBe(false);
    expect(body.state.body).toHaveLength(2000);
  });

  it('prompt sem prefixo [Nome] sai intacto', async () => {
    const { pool } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ answers: {} }) } as Response);
    await classificar(pool, 's1', 'sem prefixo nenhum');
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body.state.body).toBe('sem prefixo nenhum');
  });

  it('timeout de 1,5s corta a espera do fetch (AbortSignal.timeout)', async () => {
    const { pool } = fakePool('1');
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
    }));
    const t0 = Date.now();
    await classificar(pool, 's1', 'oi');
    expect(Date.now() - t0).toBeLessThan(1600);
  });

  it('falha aberta quando o fetch rejeita (serviço fora do ar) — não lança, não grava', async () => {
    const { pool, inserts } = fakePool('1');
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(classificar(pool, 's1', 'oi')).resolves.toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  it('falha aberta quando a resposta não é ok', async () => {
    const { pool, inserts } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 422 } as Response);
    await classificar(pool, 's1', 'oi');
    expect(inserts).toHaveLength(0);
  });

  it('grava respostas (sem o texto do prompt), latência e modelo/esforço quando o Laya responde', async () => {
    const { pool, inserts } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ answers: { injecao: { noul: 0.1 } } }) } as Response);
    await classificar(pool, 's1', 'oi', { modelo: 'sonnet', esforco: 'medium' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toBe('s1');
    expect(JSON.parse(String(inserts[0][3]))).toEqual({ injecao: { noul: 0.1 } });
    expect(inserts[0][4]).toBe('sonnet');
    expect(inserts[0][5]).toBe('medium');
    expect(inserts[0].some((v) => typeof v === 'string' && v.includes('oi'))).toBe(false);
  });
});
