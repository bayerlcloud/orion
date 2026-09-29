import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { perfilBody, seedPerfisNivel2 } from '../server/memories/seed.js';

type Chamada = { sql: string; params?: unknown[] };

function fakePool(usuariosSemPerfil: { id: number; name: string }[]) {
  const calls: Chamada[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM users')) return { rows: usuariosSemPerfil, rowCount: usuariosSemPerfil.length };
      if (sql.includes('WHERE code = $1')) return { rows: [], rowCount: 0 }; // uniqueCode: código livre
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('seedPerfisNivel2', () => {
  it('cria perfil-<slug> nível 2, escopo do usuário, rewritable, com o esqueleto de seções', async () => {
    const { pool, calls } = fakePool([{ id: 2, name: 'Laís' }]);
    const criados = await seedPerfisNivel2(pool);
    expect(criados).toEqual(['perfil-lais']);

    // A seleção pula quem já tem QUALQUER nível 2 de escopo próprio (danilo-role cobre o Danilo).
    const sel = calls.find((c) => c.sql.includes('FROM users'))!;
    expect(sel.sql).toContain('NOT EXISTS');
    expect(sel.sql).toContain('m.level = 2');
    expect(sel.sql).toContain('m.scope_user_id = u.id');

    const insert = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(insert.sql).toContain('scope_user_id');
    expect(insert.sql).toContain('ON CONFLICT (code) DO NOTHING');
    const [code, title, summary, body, userId] = insert.params as any[];
    expect(code).toBe('perfil-lais');
    expect(title).toBe('Perfil de Laís');
    expect(summary).toContain('a IA preenche conforme aprende');
    expect(summary.length).toBeLessThanOrEqual(144);
    expect(body).toContain('## Preferências');
    expect(body).toContain('## Contexto');
    expect(userId).toBe(2);
  });

  it('idempotente: sem usuário faltando perfil, não insere nada', async () => {
    const { pool, calls } = fakePool([]);
    const criados = await seedPerfisNivel2(pool);
    expect(criados).toEqual([]);
    expect(calls.some((c) => c.sql.includes('INSERT INTO memories'))).toBe(false);
  });

  it('perfilBody traz as duas seções vazias', () => {
    const b = perfilBody('Gustavo');
    expect(b).toContain('# Perfil de Gustavo');
    expect(b.indexOf('## Preferências')).toBeLessThan(b.indexOf('## Contexto'));
  });
});
