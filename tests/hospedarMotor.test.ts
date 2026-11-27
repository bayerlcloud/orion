import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { Motor } from '../server/claude/motor.js';
import type { SessionStatus, Store } from '../server/claude/runner.js';
import { fakeQuery } from './helpers/sdkFalso';

// Sem ler /srv/builds/status.json de verdade: a retomada no boot espera até 3 min por um deploy 'rodando'.
vi.mock('../server/deploy/estado.js', async (orig) => ({ ...(await orig<object>()), lerStatus: async () => null, tailDoLog: async () => '' }));
// Mesmos cortes de tests/motorLocal.test.ts (montarTurno sem disco nem git), pro teste do SDK falso por env.
vi.mock('../server/tools/skillPrefs.js', () => ({ composicaoPara: async () => ({ disallowedTools: [] }) }));
vi.mock('../server/tasks/git.js', async (orig) => ({ ...(await orig<object>()), branchAtual: async () => 'main' }));
vi.mock('../server/tools/leveza.js', async (orig) => ({ ...(await orig<object>()), remoteOrigin: async () => null }));

import { hospedarMotor } from '../server/claude/hospedarMotor.js';
import { iniciarRetomada, NAO_RETOMADA, RESUME_PROMPT, VIGIA_PROMPT } from '../server/claude/retomada.js';

type Linha = Record<string, unknown>;

/** Pool falso: só as consultas da retomada (`cortadas` = running/waiting no boot; `erro` = o que o vigia acha). */
function fakePool(o: { cortadas?: Linha[]; erro?: Linha[]; ultimoEvento?: Record<string, string> } = {}) {
  const chamadas: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params });
    if (sql.includes("WHERE s.status IN ('running','waiting')")) return { rows: o.cortadas ?? [], rowCount: 0 };
    if (sql.includes("WHERE s.status = 'error'")) return { rows: o.erro ?? [], rowCount: 0 };
    if (sql.includes('SELECT type FROM claude_events WHERE session_id')) { const t = o.ultimoEvento?.[params?.[0] as string]; return { rows: t ? [{ type: t }] : [], rowCount: t ? 1 : 0 }; }
    // montarTurno (sessão neutra s1 do usuário 1), só pro teste do SDK falso por env.
    if (sql.includes('FROM claude_sessions s LEFT JOIN projects p')) return { rows: [{ id: 's1', cwd: '/home/danilo/neutro', project_id: null, user_id: 1, creator: 'Danilo', output_style: null, project_name: null, rules: null }], rowCount: 1 };
    if (sql.includes('SELECT role FROM users')) return { rows: [{ role: 'member' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, chamadas };
}

function motorFalso(status: Record<string, SessionStatus> = {}) {
  const m = {
    iniciarTurno: vi.fn(async () => ({ queued: false })),
    status: vi.fn((id: string) => status[id] ?? 'idle'),
    parar: vi.fn(), decidir: vi.fn(), aoVivo: vi.fn(), pendentes: vi.fn(() => []), comandos: vi.fn(async () => []), assinar: vi.fn(() => () => {}), online: () => true,
  };
  return m as unknown as Motor & typeof m;
}

function storeFalso() {
  const s = { appendEvent: vi.fn(async () => {}), updateSession: vi.fn(async () => {}), createApproval: vi.fn(async () => {}), decideApproval: vi.fn(async () => {}) };
  return s as Store & typeof s;
}

const sessao = (extra: Linha): Linha => ({ user_id: 1, permission_mode: 'acceptEdits', model: null, effort: null, last_error: null, recentes: [], ...extra });

afterEach(() => { vi.useRealTimers(); });

describe('hospedarMotor (modo local)', () => {
  it('para os scopes orion-sessao-* no boot e registra o handler de SIGTERM; fechar() tira o handler', async () => {
    const antes = process.listeners('SIGTERM');
    const pararScopes = vi.fn(async (_padrao: string, _env: Record<string, string>) => {});
    const { pool, chamadas } = fakePool();
    const h = await hospedarMotor({ pool, log: () => {}, queryFn: fakeQuery().fn, pararScopes });
    try {
      expect(pararScopes).toHaveBeenCalledTimes(1);
      expect(pararScopes.mock.calls[0][0]).toBe('orion-sessao-*');
      expect(pararScopes.mock.calls[0][1]).toHaveProperty('XDG_RUNTIME_DIR');
      expect(process.listeners('SIGTERM').length).toBe(antes.length + 1);
      expect(h.motor.online()).toBe(true);
      expect(h.motor.status('qualquer')).toBe('idle');
      // Retomada no boot: zera quem estava running/waiting.
      expect(chamadas.some(c => c.sql.includes("SET status = 'idle' WHERE status IN ('running','waiting')"))).toBe(true);
    } finally {
      await h.fechar();
      // fechar() tem que tirar o handler de SIGTERM: a asserção vem ANTES de qualquer limpeza de segurança.
      expect(process.listeners('SIGTERM').length).toBe(antes.length);
      for (const l of process.listeners('SIGTERM')) if (!antes.includes(l)) process.removeListener('SIGTERM', l);
    }
  });
});

describe('SDK falso por env (ORION_SDK_FALSO=1)', () => {
  const CHAVES = ['ORION_SDK_FALSO', 'ORION_SDK_FALSO_PERMITIDO', 'ORION_SDK_FALSO_MS', 'NODE_ENV'] as const;
  const antes = Object.fromEntries(CHAVES.map(k => [k, process.env[k]]));
  afterEach(() => { for (const k of CHAVES) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; } });

  it('em NODE_ENV=production sem ORION_SDK_FALSO_PERMITIDO=1 recusa no boot, antes de mexer nos scopes', async () => {
    process.env.ORION_SDK_FALSO = '1'; process.env.NODE_ENV = 'production'; delete process.env.ORION_SDK_FALSO_PERMITIDO;
    const pararScopes = vi.fn(async () => {});
    await expect(hospedarMotor({ pool: fakePool().pool, log: () => {}, pararScopes })).rejects.toThrow(/ORION_SDK_FALSO_PERMITIDO=1/);
    expect(pararScopes).not.toHaveBeenCalled();
  });

  it('com permissão sobe avisando no log e um iniciarTurno responde eco sem subir o claude', async () => {
    process.env.ORION_SDK_FALSO = '1'; process.env.NODE_ENV = 'production'; process.env.ORION_SDK_FALSO_PERMITIDO = '1'; process.env.ORION_SDK_FALSO_MS = '0';
    const logs: string[] = [];
    const h = await hospedarMotor({ pool: fakePool().pool, log: m => logs.push(m), pararScopes: vi.fn(async () => {}) });
    try {
      expect(logs).toContain('motor: SDK FALSO ligado (sem tokens)');
      const vistos: { type: string; message?: { type: string; message?: { content?: { text: string }[] } } }[] = [];
      h.motor.assinar('s1', e => vistos.push(e as typeof vistos[number]));
      await h.motor.iniciarTurno({ sessionId: 's1', userId: 1, prompt: '[Danilo] oi', mode: 'acceptEdits', isNew: true });
      await vi.waitFor(() => expect(vistos.some(e => e.type === 'turn_end')).toBe(true));
      expect(vistos.filter(e => e.type === 'message' && e.message?.type === 'assistant').map(e => e.message!.message!.content![0].text)).toEqual(['eco: [Danilo] oi']);
      expect(h.motor.status('s1')).toBe('idle');
    } finally { await h.motor.parar('s1'); await h.fechar(); }
  });
});

describe('retomada no boot', () => {
  it('retoma a sessão cortada e desiste (NAO_RETOMADA) da que já teve 3 retomadas automáticas seguidas', async () => {
    const agora = Date.now();
    const auto = (min: number) => ({ prompt: `[Orion] ${RESUME_PROMPT}`, ts: new Date(agora - min * 60_000).toISOString() });
    const s1 = sessao({ id: 's1', permission_mode: 'plan', model: 'opus', effort: 'high', recentes: [{ prompt: '[Danilo] faz', ts: new Date(agora - 60_000).toISOString() }] });
    const s2 = sessao({ id: 's2', user_id: 2, recentes: [auto(1), auto(3), auto(5)] });
    const { pool, chamadas } = fakePool({ cortadas: [s1, s2] });
    const motor = motorFalso(); const store = storeFalso();
    const r = await iniciarRetomada({ pool, motor, store, log: () => {} });
    try {
      await vi.waitFor(() => expect(motor.iniciarTurno).toHaveBeenCalledTimes(1));
      expect(motor.iniciarTurno).toHaveBeenCalledWith({ sessionId: 's1', userId: 1, prompt: `[Orion] ${RESUME_PROMPT}`, mode: 'plan', model: 'opus', effort: 'high', isNew: false });
      await vi.waitFor(() => expect(store.appendEvent).toHaveBeenCalledWith('s2', 'error', { message: NAO_RETOMADA }));
      expect(chamadas.some(c => c.sql.includes("SET status = 'error', last_error = $2") && c.params?.[0] === 's2' && c.params?.[1] === NAO_RETOMADA)).toBe(true);
      expect(chamadas.some(c => c.sql.includes("SET status = 'idle' WHERE status IN ('running','waiting')"))).toBe(true);
    } finally { r.fechar(); }
  });

  it('corrida com o vigia: não retoma no boot quem já está em turno no motor nem quem já concluiu um turno (último evento result)', async () => {
    const emTurno = sessao({ id: 'a1' });
    const concluida = sessao({ id: 'b1' });
    const cortada = sessao({ id: 'c1' });
    const { pool } = fakePool({ cortadas: [emTurno, concluida, cortada], ultimoEvento: { a1: 'user_prompt', b1: 'result', c1: 'error' } });
    const motor = motorFalso({ a1: 'running' }); const store = storeFalso();
    const avisos: string[] = [];
    const r = await iniciarRetomada({ pool, motor, store, log: m => avisos.push(m) });
    try {
      await vi.waitFor(() => expect(motor.iniciarTurno).toHaveBeenCalledTimes(1));
      expect(motor.iniciarTurno).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'c1' }));
      expect(store.appendEvent).not.toHaveBeenCalled();
      expect(avisos).toEqual(expect.arrayContaining([expect.stringContaining('a1 já está em turno'), expect.stringContaining('b1 já concluiu um turno')]));
    } finally { r.fechar(); }
  });

  it('vigia (2 min): pula sessão que o motor diz rodando, retoma a parada com VIGIA_PROMPT; fechar() desliga', async () => {
    vi.useFakeTimers();
    const rodando = sessao({ id: 'r1', last_error: 'boom' });
    const parada = sessao({ id: 'p1', permission_mode: 'xyz', last_error: 'overloaded' });
    const { pool } = fakePool({ erro: [rodando, parada] });
    const motor = motorFalso({ r1: 'running' });
    const r = await iniciarRetomada({ pool, motor, store: storeFalso(), log: () => {} });
    expect(motor.iniciarTurno).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(motor.iniciarTurno).toHaveBeenCalledTimes(1);
    expect(motor.iniciarTurno).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'p1', mode: 'acceptEdits', isNew: false, prompt: `[Orion] ${VIGIA_PROMPT('overloaded')}` }));
    r.fechar();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(motor.iniciarTurno).toHaveBeenCalledTimes(1);
  });
});
