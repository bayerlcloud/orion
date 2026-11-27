import { describe, it, expect, vi } from 'vitest';
import type { Motor } from '../server/claude/motor.js';
import { modoDoRunner, montarRunner } from '../server/runnerMain.js';

describe('runnerMain: modo pelo central.env', () => {
  it('modoDoRunner: só ORION_RUNNER=socket faz o runner dono das sessões', () => {
    expect(modoDoRunner({})).toBe('ocioso');
    expect(modoDoRunner({ ORION_RUNNER: 'local' })).toBe('ocioso');
    expect(modoDoRunner({ ORION_RUNNER: 'socket' })).toBe('socket');
  });

  it('ocioso (deploy 1, painel local dono das sessões): só /saude, sem pool, sem hospedarMotor', async () => {
    const hospedar = vi.fn(); const criarPool = vi.fn(); const logs: string[] = [];
    const app = await montarRunner({ env: { ORION_RUNNER: 'local' }, hospedar: hospedar as never, criarPool: criarPool as never, log: m => logs.push(m) });
    expect((await app.inject('/saude')).json()).toMatchObject({ ok: true, ocioso: true, pid: process.pid });
    expect((await app.inject('/eventos')).statusCode).toBe(404);
    expect(hospedar).not.toHaveBeenCalled();
    expect(criarPool).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/runner ocioso até a virada/);
    await app.close();
  });

  it('socket: abre o pool, espera claude_sessions, hospeda o motor e serve as rotas dele', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const motor = { vivas: () => [{ id: 'a', status: 'running', pending: [] }], status: () => 'running', pendentes: () => [] } as unknown as Motor;
    const hospedar = vi.fn(async () => ({ motor, fechar: async () => {} }));
    const app = await montarRunner({ env: { ORION_RUNNER: 'socket' }, hospedar: hospedar as never, criarPool: (() => pool) as never, log: () => {} });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1 FROM claude_sessions');
    expect(hospedar).toHaveBeenCalledTimes(1);
    expect((hospedar.mock.calls[0] as unknown[])[0]).toMatchObject({ pool });
    expect((await app.inject('/saude')).json()).toMatchObject({ ok: true, vivas: 1 });
    expect((await app.inject('/sessoes/a')).json()).toEqual({ status: 'running', pending: [] });
    await app.close();
  });
});
