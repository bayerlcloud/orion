import { describe, it, expect, vi } from 'vitest';
import type { Motor } from '../server/claude/motor.js';
import { criarServidorMotor } from '../server/claude/motorServidor.js';

/** Motor falso: só o que as rotas simples tocam (o caminho completo, com Runner, está em motorSocket.test.ts). */
function motorFalso() {
  const m = {
    vivas: vi.fn(() => [{ id: 'a', status: 'running' as const, pending: [] }, { id: 'b', status: 'idle' as const, pending: [] }]),
    status: vi.fn(() => 'running' as const),
    pendentes: vi.fn(() => [{ id: 'p1', toolName: 'Bash' }]),
    comandos: vi.fn(async () => [{ name: 'x', description: 'y', argumentHint: '' }]),
    aoVivo: vi.fn(async () => true),
    decidir: vi.fn(async (_id: string, approvalId: string) => approvalId === 'p1'),
    parar: vi.fn(async () => {}),
    iniciarTurno: vi.fn(async () => ({ queued: true })),
    assinar: vi.fn(() => () => {}), assinarTudo: vi.fn(() => () => {}), online: () => true,
  };
  return m as unknown as Motor & typeof m;
}

describe('criarServidorMotor (rotas por pedido)', () => {
  it('/saude, /sessoes/:id, comandos, ao-vivo, decisão e turno repassam ao motor', async () => {
    const m = motorFalso();
    const app = criarServidorMotor(m);
    const saude = (await app.inject('/saude')).json();
    expect(saude).toMatchObject({ ok: true, pid: process.pid, vivas: 2 });
    expect(typeof saude.iniciadoEm).toBe('string');

    expect((await app.inject('/sessoes/a')).json()).toEqual({ status: 'running', pending: [{ id: 'p1', toolName: 'Bash' }] });
    expect((await app.inject('/sessoes/a/comandos')).json()).toEqual({ commands: [{ name: 'x', description: 'y', argumentHint: '' }] });

    const vivo = await app.inject({ method: 'POST', url: '/sessoes/a/ao-vivo', payload: { campo: 'mode', valor: 'plan' } });
    expect(vivo.json()).toEqual({ live: true });
    expect(m.aoVivo).toHaveBeenCalledWith('a', 'mode', 'plan');

    const nao = await app.inject({ method: 'POST', url: '/sessoes/a/decisao', payload: { approvalId: 'zzz', decision: 'allow', decidedBy: 1 } });
    expect(nao.statusCode).toBe(404);
    const sim = await app.inject({ method: 'POST', url: '/sessoes/a/decisao', payload: { approvalId: 'p1', decision: 'answer', decidedBy: null, message: 'ok' } });
    expect(sim.json()).toEqual({ ok: true });
    expect(m.decidir).toHaveBeenLastCalledWith('a', 'p1', 'answer', null, 'ok');

    const turno = await app.inject({ method: 'POST', url: '/sessoes/a/turno', payload: { userId: 1, prompt: 'oi', mode: 'acceptEdits', isNew: false } });
    expect(turno.json()).toEqual({ ok: true, queued: true });
    expect(m.iniciarTurno).toHaveBeenCalledWith({ sessionId: 'a', userId: 1, prompt: 'oi', mode: 'acceptEdits', isNew: false });

    expect((await app.inject({ method: 'POST', url: '/sessoes/a/parar' })).json()).toEqual({ ok: true });
    expect(m.parar).toHaveBeenCalledWith('a');
    await app.close();
  });
});
