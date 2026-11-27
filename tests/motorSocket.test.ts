import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilaIntegracao } from '../server/integracao/fila.js';
import { fakeQuery, until } from './helpers/sdkFalso';

// Mesmos cortes de tests/motorLocal.test.ts: nada de disco nem git.
vi.mock('../server/tools/skillPrefs.js', () => ({ composicaoPara: async () => ({ disallowedTools: ['Skill(x)'] }) }));
vi.mock('../server/tasks/git.js', async (orig) => ({ ...(await orig<object>()), branchAtual: async () => 'main' }));
vi.mock('../server/tools/leveza.js', async (orig) => ({ ...(await orig<object>()), remoteOrigin: async () => null }));

import { Runner, type LiveEvent, type Store } from '../server/claude/runner.js';
import { MotorLocal } from '../server/claude/motorLocal.js';
import type { PedidoTurno } from '../server/claude/montarTurno.js';
import { criarServidorMotor } from '../server/claude/motorServidor.js';
import { MotorIndisponivel, MotorSocket } from '../server/claude/motorSocket.js';

const NEUTRO = '/home/danilo/neutro';

function fakePool() {
  const query = vi.fn(async (sql: string) => {
    const r = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes('FROM claude_sessions s LEFT JOIN projects p')) return r([{ id: 's1', cwd: NEUTRO, project_id: null, user_id: 1, creator: 'Danilo', output_style: null, project_name: null, rules: null }]);
    if (sql.includes('SELECT role FROM users')) return r([{ role: 'member' }]);
    return r([]);
  });
  return { query } as unknown as Pool;
}

function memStore() {
  const sessions = new Map<string, any>();
  const store: Store = {
    async appendEvent() {},
    async updateSession(sessionId, patch) { sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), ...patch }); },
    async createApproval() {},
    async decideApproval() {},
  };
  return { store, sessions };
}

const pedido = (extra: Partial<PedidoTurno> = {}): PedidoTurno =>
  ({ sessionId: 's1', userId: 1, prompt: '[Danilo] oi', mode: 'acceptEdits', model: 'sonnet', effort: 'medium', isNew: true, ...extra });

const abertos: { close(): Promise<void> }[] = [];
const clientes: MotorSocket[] = [];
const pastas: string[] = [];
afterEach(async () => {
  for (const c of clientes.splice(0)) c.fechar();
  for (const a of abertos.splice(0)) await a.close();
  for (const p of pastas.splice(0)) await rm(p, { recursive: true, force: true });
});

async function servidor(sock: string, opts: Parameters<typeof fakeQuery>[0] = {}) {
  const q = fakeQuery(opts); const m = memStore();
  const runner = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 0 });
  const motor = new MotorLocal({ runner, pool: fakePool(), fila: new FilaIntegracao(), log: () => {} });
  const app = criarServidorMotor(motor);
  await unlink(sock).catch(() => {}); // o Node não apaga o socket ao fechar (mesmo cuidado do runnerMain)
  await app.listen({ path: sock });
  abertos.push(app);
  return { app, motor, runner, q, m };
}

function cliente(sock: string, aoReconectar = vi.fn()) {
  const c = new MotorSocket({ sock, log: () => {}, aoReconectar });
  clientes.push(c);
  return { c, aoReconectar };
}

const sockTemp = async () => { const p = await mkdtemp(path.join(tmpdir(), 'orion-t3-')); pastas.push(p); return path.join(p, 'r.sock'); };

describe('MotorSocket <-> criarServidorMotor', () => {
  it('hello traz as sessões vivas do runner; status/vivas do cliente espelham', async () => {
    const sock = await sockTemp();
    const s = await servidor(sock, { slow: 300 });
    await s.motor.iniciarTurno(pedido());
    const { c, aoReconectar } = cliente(sock);
    await until(() => c.online());
    expect(aoReconectar).toHaveBeenCalledTimes(1);
    expect(c.vivas()).toEqual([{ id: 's1', status: 'running', pending: [] }]);
    expect(c.status('s1')).toBe('running');
    await until(() => c.status('s1') === 'idle');
  });

  it('iniciarTurno pelo socket: assinante do cliente recebe os eventos e o status termina idle', async () => {
    const sock = await sockTemp();
    const s = await servidor(sock);
    const { c } = cliente(sock);
    await until(() => c.online());
    const vistos: LiveEvent[] = []; c.assinar('s1', e => vistos.push(e));
    const tudo: string[] = []; c.assinarTudo((id, e) => tudo.push(`${id}:${e.type}`));
    const { queued } = await c.iniciarTurno(pedido());
    expect(queued).toBe(true); // contrato do MotorLocal: a sessão já não está ociosa depois do startTurn
    await until(() => c.status('s1') === 'idle' && vistos.some(e => e.type === 'turn_end'));
    const msgs = vistos.filter((e): e is Extract<LiveEvent, { type: 'message' }> => e.type === 'message').map(e => (e.message as { type: string }).type);
    expect(msgs).toEqual(expect.arrayContaining(['user', 'assistant', 'result']));
    expect(vistos.map(e => e.type)).toEqual(expect.arrayContaining(['status', 'message', 'turn_end']));
    expect(tudo).toContain('s1:turn_end');
    expect(s.q.calls[0].options.cwd).toBe(NEUTRO);
    expect(await c.comandos('s1')).toEqual([]);
    expect(await c.aoVivo('s1', 'mode', 'plan')).toBe(false); // sem Query viva
  });

  it('permissão: o espelho ganha a pendência; decidir resolve no Runner e esvazia', async () => {
    const sock = await sockTemp();
    const s = await servidor(sock, { askPermission: true });
    const { c } = cliente(sock);
    await until(() => c.online());
    await c.iniciarTurno(pedido());
    await until(() => c.pendentes('s1').length === 1);
    expect(c.status('s1')).toBe('waiting');
    const [p] = c.pendentes('s1');
    expect(p.toolName).toBe('Bash');
    expect(s.runner.pendingPermissions('s1')).toHaveLength(1);
    expect(await c.decidir('s1', 'nao-existe', 'allow', 1)).toBe(false);
    expect(await c.decidir('s1', p.id, 'allow', 1)).toBe(true);
    await until(() => c.status('s1') === 'idle');
    expect(c.pendentes('s1')).toEqual([]);
    expect(s.runner.pendingPermissions('s1')).toEqual([]);
  });

  it('parar: o cliente recebe interrupted e o status volta a idle', async () => {
    const sock = await sockTemp();
    await servidor(sock, { slow: 150 });
    const { c } = cliente(sock);
    await until(() => c.online());
    const vistos: string[] = []; c.assinar('s1', e => vistos.push(e.type));
    await c.iniciarTurno(pedido());
    await until(() => c.status('s1') === 'running');
    await c.parar('s1');
    await until(() => vistos.includes('interrupted'));
    await until(() => c.status('s1') === 'idle');
  });

  it('servidor derrubado e outro no mesmo socket: reconecta, hello novo substitui o espelho, aoReconectar mais 1 vez', async () => {
    const sock = await sockTemp();
    const s1 = await servidor(sock);
    const { c, aoReconectar } = cliente(sock);
    await until(() => c.online());
    expect(aoReconectar).toHaveBeenCalledTimes(1);
    await s1.app.close();
    await until(() => !c.online());
    await expect(c.iniciarTurno(pedido())).rejects.toBeInstanceOf(MotorIndisponivel);
    const s2 = await servidor(sock, { slow: 300 });
    await s2.motor.iniciarTurno(pedido({ sessionId: 's1' }));
    await until(() => c.online(), 8000);
    expect(aoReconectar).toHaveBeenCalledTimes(2);
    expect(c.vivas().map(v => v.id)).toEqual(['s1']);
    await until(() => c.status('s1') === 'idle');
  });

  it('servidor fora desde o início: online() false e escrita lança MotorIndisponivel', async () => {
    const sock = await sockTemp();
    const { c } = cliente(sock);
    expect(c.online()).toBe(false);
    await expect(c.iniciarTurno(pedido())).rejects.toBeInstanceOf(MotorIndisponivel);
    await expect(c.parar('s1')).rejects.toBeInstanceOf(MotorIndisponivel);
    expect(c.status('s1')).toBe('idle');
    expect(c.pendentes('s1')).toEqual([]);
  });
});
