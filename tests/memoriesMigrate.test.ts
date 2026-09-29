import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { mapearNivel, ensureMemoriesSchema, type LinhaAntiga } from '../server/memories/migrate.js';

const linha = (p: Partial<LinhaAntiga>): LinhaAntiga => ({
  code: 'x', status: 'rascunho', learning_level: null, scope_project_id: null, scope_user_id: null, ...p,
});

describe('mapearNivel (mapeamento fechado da migração)', () => {
  it('codes conhecidos vão para o andar combinado', () => {
    expect(mapearNivel(linha({ code: 'constituicao-nivel-0', status: 'deus' }))).toEqual({ level: 0, nota: null });
    for (const c of ['nivel1-mapa', 'nivel1-equipe-e-projetos', 'nivel1-capacidades']) {
      expect(mapearNivel(linha({ code: c, status: 'aprendizagem', learning_level: 5 }))).toEqual({ level: 1, nota: null });
    }
    expect(mapearNivel(linha({ code: 'danilo-role', status: 'aprendizagem', learning_level: 3, scope_user_id: 1 })))
      .toEqual({ level: 2, nota: null });
    expect(mapearNivel(linha({ code: 'orion-project', status: 'aprendizagem', learning_level: 3, scope_project_id: 1 })))
      .toEqual({ level: 2, nota: null });
    expect(mapearNivel(linha({ code: 'orion-central-unico-painel', status: 'deus' }))).toEqual({ level: 3, nota: null });
  });

  it('regra geral: deus vira decisão (3)', () => {
    expect(mapearNivel(linha({ code: 'qualquer-deus', status: 'deus' }))).toEqual({ level: 3, nota: null });
  });

  it('regra geral: aprendizagem com escopo vira decisão (3); sem escopo vira micro-fato nota 5', () => {
    expect(mapearNivel(linha({ code: 'apr-proj', status: 'aprendizagem', scope_project_id: 2 }))).toEqual({ level: 3, nota: null });
    expect(mapearNivel(linha({ code: 'apr-user', status: 'aprendizagem', scope_user_id: 9 }))).toEqual({ level: 3, nota: null });
    expect(mapearNivel(linha({ code: 'apr-solta', status: 'aprendizagem' }))).toEqual({ level: 4, nota: 5 });
  });

  it('regra geral: rascunho e qualquer sobra viram micro-fato nota 5', () => {
    expect(mapearNivel(linha({ code: 'rasc', status: 'rascunho' }))).toEqual({ level: 4, nota: 5 });
    expect(mapearNivel(linha({ code: 'estranho', status: 'outra-coisa' }))).toEqual({ level: 4, nota: 5 });
  });
});

type Chamada = { sql: string; params?: unknown[] };

function fakePool(opts: { temStatus: boolean; linhas?: (LinhaAntiga & { id: number })[]; temCks?: boolean }) {
  const calls: Chamada[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('information_schema.columns')) return { rows: [], rowCount: opts.temStatus ? 1 : 0 };
      if (sql.includes('WHERE level IS NULL') && sql.trimStart().startsWith('SELECT')) {
        return { rows: opts.linhas ?? [], rowCount: (opts.linhas ?? []).length };
      }
      if (sql.includes('pg_constraint')) return { rows: [], rowCount: opts.temCks ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('ensureMemoriesSchema', () => {
  it('esquema antigo: mapeia cada linha, remove status/learning_level e fecha as constraints novas', async () => {
    const linhas = [
      { id: 5, ...linha({ code: 'danilo-role', status: 'aprendizagem', learning_level: 3, scope_user_id: 1 }) },
      { id: 7, ...linha({ code: 'constituicao-nivel-0', status: 'deus' }) },
      { id: 8, ...linha({ code: 'nivel1-mapa', status: 'aprendizagem', learning_level: 5 }) },
    ];
    const { pool, calls } = fakePool({ temStatus: true, linhas });
    await ensureMemoriesSchema(pool);

    const updates = calls.filter((c) => c.sql.includes('SET level = $2'));
    expect(updates.map((c) => c.params)).toEqual([
      [5, 2, null],
      [7, 0, null],
      [8, 1, null],
    ]);
    const drop = calls.find((c) => c.sql.includes('DROP COLUMN IF EXISTS status'));
    expect(drop).toBeTruthy();
    expect(drop!.sql).toContain('DROP COLUMN IF EXISTS learning_level');
    expect(drop!.sql).toContain('DROP CONSTRAINT IF EXISTS memories_level_ck');
    expect(calls.some((c) => c.sql.includes('ADD CONSTRAINT memories_nivel_ck'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('ADD CONSTRAINT memories_nota_ck'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('ALTER COLUMN level SET NOT NULL'))).toBe(true);
  });

  it('segunda rodada (já migrado): não mexe em linha nenhuma nem repete drops e constraints', async () => {
    const { pool, calls } = fakePool({ temStatus: false, temCks: true });
    await ensureMemoriesSchema(pool);
    expect(calls.some((c) => c.sql.includes('SET level = $2'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('DROP COLUMN'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('ADD CONSTRAINT'))).toBe(false);
    // as colunas novas continuam garantidas com IF NOT EXISTS (seguro rodar 2x)
    expect(calls.some((c) => c.sql.includes('ADD COLUMN IF NOT EXISTS level'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('ADD COLUMN IF NOT EXISTS last_decay_at'))).toBe(true);
  });
});
