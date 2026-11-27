import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { FilaIntegracao } from '../server/integracao/fila.js';
import { fakeQuery, until } from './helpers/sdkFalso';

// Mesmos cortes de tests/montarTurno.test.ts: nada de disco nem git.
vi.mock('../server/tools/skillPrefs.js', () => ({ composicaoPara: async () => ({ disallowedTools: ['Skill(x)'] }) }));
vi.mock('../server/tasks/git.js', async (orig) => ({ ...(await orig<object>()), branchAtual: async () => 'main' }));
vi.mock('../server/tools/leveza.js', async (orig) => ({ ...(await orig<object>()), remoteOrigin: async () => null }));

import { Runner, type Store } from '../server/claude/runner.js';
import { MotorLocal } from '../server/claude/motorLocal.js';
import { montarTurno, type PedidoTurno } from '../server/claude/montarTurno.js';

const NEUTRO = '/home/danilo/neutro';

/** Pool falso: sessão neutra (sem projeto, sem ganchos de git). `paralelas` = títulos das sessões rodando na mesma pasta. */
function fakePool(paralelas: string[] = []) {
  const query = vi.fn(async (sql: string) => {
    const r = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes('FROM claude_sessions s LEFT JOIN projects p')) return r([{ id: 's1', cwd: NEUTRO, project_id: null, user_id: 1, creator: 'Danilo', output_style: null, project_name: null, rules: null }]);
    if (sql.includes('SELECT title FROM claude_sessions WHERE cwd')) return r(paralelas.map(title => ({ title })));
    if (sql.includes('SELECT role FROM users')) return r([{ role: 'member' }]);
    return r([]);
  });
  return { query } as unknown as Pool;
}

function memStore() {
  const events: { sessionId: string; type: string; payload: any }[] = [];
  const sessions = new Map<string, any>();
  const store: Store = {
    async appendEvent(sessionId, type, payload) { events.push({ sessionId, type, payload }); },
    async updateSession(sessionId, patch) { sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), ...patch }); },
    async createApproval() {},
    async decideApproval() {},
  };
  return { store, events, sessions };
}

const pedido = (extra: Partial<PedidoTurno> = {}): PedidoTurno =>
  ({ sessionId: 's1', userId: 1, prompt: '[Danilo] oi', mode: 'acceptEdits', model: 'sonnet', effort: 'medium', isNew: true, ...extra });

function montar(opts: Parameters<typeof fakeQuery>[0] = {}, paralelas: string[] = []) {
  const q = fakeQuery(opts); const m = memStore();
  const runner = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 0 });
  const pool = fakePool(paralelas);
  const motor = new MotorLocal({ runner, pool, fila: new FilaIntegracao(), log: () => {} });
  return { q, m, runner, pool, motor };
}

describe('MotorLocal', () => {
  it('iniciarTurno = montarTurno + startTurn: eventos, assinantes e opções do SDK iguais ao Runner direto', async () => {
    const a = montar();
    const vistosA: string[] = []; a.motor.assinar('s1', e => vistosA.push(e.type));
    await a.motor.iniciarTurno(pedido());
    await until(() => a.m.sessions.get('s1')?.status === 'idle');

    const b = montar();
    const vistosB: string[] = []; b.runner.subscribe('s1', e => vistosB.push(e.type));
    b.runner.startTurn(await montarTurno(b.pool, new FilaIntegracao(), pedido(), { registrar: () => {}, log: () => {} }));
    await until(() => b.m.sessions.get('s1')?.status === 'idle');

    expect(a.m.events.map(e => e.type)).toEqual(['user_prompt', 'system', 'assistant', 'result']);
    expect(a.m.events.map(e => e.type)).toEqual(b.m.events.map(e => e.type));
    expect(vistosA).toEqual(vistosB);
    expect(a.q.calls[0].options.cwd).toBe(NEUTRO);
    expect(a.q.calls[0].options.systemPrompt).toEqual(b.q.calls[0].options.systemPrompt);
    expect(a.q.calls[0].options.permissionMode).toBe('acceptEdits');
    expect(a.motor.status('s1')).toBe('idle');
    expect(a.motor.online()).toBe(true);
  });

  it('vivas() lista a sessão em turno (hello do stream global, T3)', async () => {
    const { motor, runner, m } = montar({ slow: 150 });
    expect(runner.vivas()).toEqual([]);
    await motor.iniciarTurno(pedido());
    expect(runner.vivas()).toEqual([{ id: 's1', status: 'running', pending: [] }]);
    await until(() => m.sessions.get('s1')?.status === 'idle');
    expect(runner.vivas()).toEqual([{ id: 's1', status: 'idle', pending: [] }]);
  });

  it('avisos que a rota fazia: pasta sem worktree e sessão paralela na mesma pasta (só em turno não novo)', async () => {
    const { motor, m } = montar({}, ['Outra sessão']);
    await motor.iniciarTurno(pedido({ isNew: false, avisoPasta: 'Sessão na raiz do projeto' }));
    await until(() => m.sessions.get('s1')?.status === 'idle');
    const avisos = m.events.filter(e => e.type === 'system' && e.payload.subtype === 'orion_aviso').map(e => e.payload.text);
    expect(avisos).toEqual(['Sessão na raiz do projeto', expect.stringContaining('"Outra sessão" está rodando agora na mesma pasta')]);
  });

  it('aoVivo traduz campo -> control method do SDK; pendentes/comandos delegam', async () => {
    const { motor, m, q } = montar({ slow: 150, liveControls: true });
    await motor.iniciarTurno(pedido());
    await until(() => q.calls.length === 1); // a Query só existe depois que run() chamou o SDK
    expect(await motor.aoVivo('s1', 'mode', 'plan')).toBe(true);
    expect(await motor.aoVivo('s1', 'model', undefined)).toBe(true);
    expect(await motor.aoVivo('s1', 'effort', 'high')).toBe(true);
    expect(await motor.aoVivo('s1', 'outputStyle', null)).toBe(true);
    expect(q.liveCalls).toEqual([
      { type: 'setPermissionMode', mode: 'plan' },
      { type: 'setModel', model: undefined },
      { type: 'applyFlagSettings', settings: { effortLevel: 'high' } },
      { type: 'applyFlagSettings', settings: { outputStyle: null } },
    ]);
    expect(motor.pendentes('s1')).toEqual([]);
    expect(await motor.comandos('s1')).toEqual([]);
    await until(() => m.sessions.get('s1')?.status === 'idle');
    expect(await motor.aoVivo('s1', 'mode', 'auto')).toBe(false); // sem Query viva
  });
});
