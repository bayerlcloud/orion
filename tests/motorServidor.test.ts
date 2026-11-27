import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Motor } from '../server/claude/motor.js';
import type { LiveEvent } from '../server/claude/runner.js';
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

  it('/eventos cruza o socket enxuto: sem tool_use_result inteiro nem workflow_progress (mesmo recorte do SSE do painel)', async () => {
    const m = motorFalso();
    let emitir!: (sessionId: string, e: LiveEvent) => void;
    m.assinarTudo.mockImplementation((fn: typeof emitir) => { emitir = fn; return () => {}; });
    const app = criarServidorMotor(m);
    const pasta = await mkdtemp(path.join(tmpdir(), 'orion-ev-')); const sock = path.join(pasta, 'r.sock');
    await app.listen({ path: sock });
    const linhas: any[] = [];
    await new Promise<void>((ok, erro) => {
      const req = http.request({ socketPath: sock, path: '/eventos', method: 'GET' }, res => {
        let resto = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          resto += c;
          let i: number;
          while ((i = resto.indexOf('\n')) >= 0) { const b = resto.slice(0, i); resto = resto.slice(i + 1); if (b) linhas.push(JSON.parse(b)); }
          if (linhas.length === 1) {
            emitir('a', { type: 'message', message: { type: 'user', message: { content: 'x' }, tool_use_result: { status: 'completed', totalTokens: 1, stdout: 'z'.repeat(100_000) } } as any });
            emitir('a', { type: 'message', message: { type: 'system', subtype: 'task_progress', workflow_progress: new Array(1000).fill('w') } as any });
            emitir('a', { type: 'status', status: 'idle' });
          }
          if (linhas.length >= 4) { req.destroy(); ok(); }
        });
      });
      req.on('error', e => { if (linhas.length < 4) erro(e); });
      req.end();
    });
    expect(linhas[0].type).toBe('hello');
    expect(linhas[1].event.message).toEqual({ type: 'user', message: { content: 'x' }, tool_use_result: { status: 'completed', totalTokens: 1 } });
    expect(linhas[2].event.message).toEqual({ type: 'system', subtype: 'task_progress' });
    expect(linhas[3].event).toEqual({ type: 'status', status: 'idle' });
    await app.close();
    await rm(pasta, { recursive: true, force: true });
  });
});
