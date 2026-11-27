import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { FilaIntegracao } from '../server/integracao/fila.js';
import { ULTRACODE_APPEND } from '../server/claude/ultracode.js';

// Nada de disco nem git no teste: a composição de skills lê o catálogo e escreve em COMPOSE_DIR,
// branchAtual/remoteOrigin chamam git na pasta do projeto.
vi.mock('../server/tools/skillPrefs.js', () => ({ composicaoPara: async () => ({ disallowedTools: ['Skill(x)'] }) }));
vi.mock('../server/tasks/git.js', async (orig) => ({ ...(await orig<object>()), branchAtual: async () => 'main' }));
vi.mock('../server/tools/leveza.js', async (orig) => ({ ...(await orig<object>()), remoteOrigin: async () => null }));
vi.mock('../server/integracao/turno.js', async (orig) => {
  const m = await orig<{ ganchosDaSessao: (o: unknown) => unknown }>();
  return { ...m, ganchosDaSessao: vi.fn((o: unknown) => m.ganchosDaSessao(o)) };
});

import { montarTurno, type PedidoTurno } from '../server/claude/montarTurno.js';
import { ganchosDaSessao } from '../server/integracao/turno.js';

const RAIZ = '/srv/projects/x';
const WORKTREE = '/srv/projects/x/.worktrees/danilo';

type Sessao = { id?: string; cwd?: string; project_id?: number | null; user_id?: number; creator?: string; output_style?: string | null };

/** Pool falso: roteia pelo SQL, igual aos vizinhos (tests/layaHook.test.ts). `roles` = papel por id de usuário. */
function fakePool(sessao: Sessao | null, roles: Record<number, string> = { 1: 'owner', 2: 'member' }) {
  const chamadas: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params });
    const r = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes('FROM claude_sessions s LEFT JOIN projects p')) {
      if (!sessao) return r([]);
      const projeto = sessao.project_id === null ? { project_name: null, rules: null } : { project_name: 'Projeto X', rules: 'regra do projeto' };
      return r([{ id: 's1', cwd: WORKTREE, project_id: 7, user_id: 1, creator: 'Danilo', output_style: null, ...projeto, ...sessao }]);
    }
    if (sql.includes('SELECT id, path FROM projects')) return r([{ id: 7, path: RAIZ }]);
    if (sql.includes('SELECT path, meta FROM projects')) return r([{ path: RAIZ, meta: {} }]);
    if (sql.includes('SELECT slug FROM projects')) return r([{ slug: 'x' }]);
    if (sql.includes('SELECT role FROM users')) return r(roles[params?.[0] as number] ? [{ role: roles[params?.[0] as number] }] : []);
    return r([]);
  });
  return { pool: { query } as unknown as Pool, chamadas };
}

const pedido = (extra: Partial<PedidoTurno> = {}): PedidoTurno =>
  ({ sessionId: 's1', userId: 1, prompt: '[Danilo] arruma o botão', mode: 'acceptEdits', model: 'sonnet', effort: 'medium', isNew: false, ...extra });

const deps = { registrar: vi.fn(), log: vi.fn() };
const fila = new FilaIntegracao();

describe('montarTurno', () => {
  it('sessão em worktree: MCPs orion-memory, orion-root e orion-publicar, ganchos de integração e header do projeto', async () => {
    const { pool } = fakePool({});
    const p = await montarTurno(pool, fila, pedido(), deps);
    expect(p.sessionId).toBe('s1');
    expect(p.cwd).toBe(WORKTREE);
    expect(p.isNew).toBe(false);
    expect(p.permissionMode).toBe('acceptEdits');
    expect(p.effort).toBe('medium');
    expect(Object.keys(p.mcpServers ?? {})).toEqual(['orion-memory', 'orion-root', 'orion-senhas', 'orion-publicar']);
    expect(p.ganchos?.publicador).toBeTruthy();
    expect(p.systemAppend).toContain('Projeto X');
    expect(p.systemAppend).toContain('regra do projeto');
    expect(p.disallowedTools).toEqual(['Skill(x)']);
    expect(p.outputStyle).toBeUndefined();
    expect(typeof p.layaHook).toBe('function');
    expect(p.backupSql).toBeUndefined(); // projeto sem db_url
  });

  it('sessão na raiz do projeto: sem orion-publicar nem ganchos', async () => {
    const { pool } = fakePool({ cwd: RAIZ });
    const p = await montarTurno(pool, fila, pedido(), deps);
    expect(p.ganchos).toBeUndefined();
    expect(p.mcpServers).not.toHaveProperty('orion-publicar');
    expect(p.mcpServers).toHaveProperty('orion-memory');
    expect(p.mcpServers).toHaveProperty('orion-root');
  });

  it('orion-senhas só quando quem mandou o turno é owner', async () => {
    const { pool } = fakePool({});
    expect((await montarTurno(pool, fila, pedido({ userId: 1 }), deps)).mcpServers).toHaveProperty('orion-senhas');
    expect((await montarTurno(pool, fila, pedido({ userId: 2 }), deps)).mcpServers).not.toHaveProperty('orion-senhas');
  });

  it('isNew true vira sessão nova (sem desarquivar); false vira resume e desarquiva antes', async () => {
    const nova = fakePool({});
    expect((await montarTurno(nova.pool, fila, pedido({ isNew: true }), deps)).isNew).toBe(true);
    expect(nova.chamadas.some(c => c.sql.includes('claude_events_arquivo'))).toBe(false);
    const retomada = fakePool({});
    expect((await montarTurno(retomada.pool, fila, pedido({ isNew: false }), deps)).isNew).toBe(false);
    expect(retomada.chamadas.some(c => c.sql.includes('claude_events_arquivo'))).toBe(true);
  });

  it('prefixo [Nome] do prompt vira a pessoa dos ganchos e sai do texto do commit; sem prefixo, pessoa = criador', async () => {
    const { pool } = fakePool({});
    vi.mocked(ganchosDaSessao).mockClear();
    await montarTurno(pool, fila, pedido({ prompt: '[Gustavo] troca a cor', userId: 2 }), deps);
    expect(vi.mocked(ganchosDaSessao).mock.calls[0][0]).toMatchObject({ pessoa: 'Gustavo', prompt: 'troca a cor', cwd: WORKTREE, registrar: deps.registrar });
    await montarTurno(pool, fila, pedido({ prompt: { text: 'sem prefixo', attachments: [] } }), deps);
    expect(vi.mocked(ganchosDaSessao).mock.calls[1][0]).toMatchObject({ pessoa: 'Danilo', prompt: 'sem prefixo' });
  });

  it('effort ultracode: SDK recebe xhigh e o systemAppend ganha a instrução de orquestração', async () => {
    const { pool } = fakePool({});
    const p = await montarTurno(pool, fila, pedido({ effort: 'ultracode' }), deps);
    expect(p.effort).toBe('xhigh');
    expect(p.systemAppend).toContain(ULTRACODE_APPEND);
  });

  it('sessão neutra (sem projeto): header neutro, só orion-memory e orion-root', async () => {
    const { pool } = fakePool({ project_id: null, cwd: '/home/danilo/neutro' }, { 1: 'member' });
    const p = await montarTurno(pool, fila, pedido(), deps);
    expect(p.systemAppend).toContain('sessão neutra');
    expect(Object.keys(p.mcpServers ?? {})).toEqual(['orion-memory', 'orion-root']);
  });

  it('sessão inexistente lança', async () => {
    const { pool } = fakePool(null);
    await expect(montarTurno(pool, fila, pedido(), deps)).rejects.toThrow('não existe');
  });
});
