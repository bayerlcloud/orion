import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { makeLayaHook } from '../server/claude/layaHook.js';

const opts = { signal: new AbortController().signal };

function fakePool(settingsValue: string | null) {
  const inserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT value FROM settings')) return { rows: settingsValue === null ? [] : [{ value: settingsValue }], rowCount: settingsValue === null ? 0 : 1 };
      if (sql.includes('INSERT INTO triagem_sombra')) { inserts.push(params ?? []); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, inserts };
}

const input = (prompt: string): UserPromptSubmitHookInput => ({ hook_event_name: 'UserPromptSubmit', prompt } as UserPromptSubmitHookInput);

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('makeLayaHook', () => {
  it('não chama o Laya quando laya_ativo está desligado', async () => {
    const { pool } = fakePool(null);
    const hook = makeLayaHook(pool, 's1');
    expect(await hook(input('[Guilherme] oi'), undefined, opts)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falha aberta quando o fetch rejeita (serviço fora do ar)', async () => {
    const { pool, inserts } = fakePool('1');
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const hook = makeLayaHook(pool, 's1');
    expect(await hook(input('[Guilherme] oi'), undefined, opts)).toEqual({});
    expect(inserts).toHaveLength(0);
  });

  it('falha aberta quando a resposta não é ok', async () => {
    const { pool, inserts } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    const hook = makeLayaHook(pool, 's1');
    expect(await hook(input('[Guilherme] oi'), undefined, opts)).toEqual({});
    expect(inserts).toHaveLength(0);
  });

  it('remove o prefixo [Nome] e corta em 2000 caracteres antes de mandar pro Laya', async () => {
    const { pool } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ answers: {} }) } as Response);
    const hook = makeLayaHook(pool, 's1');
    await hook(input('[Guilherme] ' + 'x'.repeat(3000)), undefined, opts);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.text.startsWith('[')).toBe(false);
    expect(body.text).toHaveLength(2000);
  });

  it('grava respostas (sem o texto do prompt) e latência quando o Laya responde', async () => {
    const { pool, inserts } = fakePool('1');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ answers: { injecao: { label: 'nao', confidence: 0.9 } } }) } as Response);
    const hook = makeLayaHook(pool, 's1');
    expect(await hook(input('[Guilherme] oi'), undefined, opts)).toEqual({});
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toBe('s1');
    expect(inserts[0][3]).toEqual({ injecao: { label: 'nao', confidence: 0.9 } });
    expect(inserts[0].some((v) => typeof v === 'string' && v.includes('oi'))).toBe(false);
  });

  it('falha aberta e não lança quando hook_event_name não é UserPromptSubmit', async () => {
    const { pool } = fakePool('1');
    const hook = makeLayaHook(pool, 's1');
    expect(await hook({ hook_event_name: 'Stop' } as any, undefined, opts)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});
