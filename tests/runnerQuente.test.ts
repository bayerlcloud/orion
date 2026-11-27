import { describe, it, expect } from 'vitest';
import { Runner, CUTUCAO, type Store, type QueryFn } from '../server/claude/runner';
import { fakeQuente } from './helpers/sdkFalso';

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
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(5); } }

const base = { cwd: '/tmp/x', permissionMode: 'acceptEdits' as const, systemAppend: 'h' };

describe('processo quente (vários turnos num query())', () => {
  it('segundo turno depois do result reaproveita o mesmo processo: 1 query(), 2 prompts, 2 results, idle entre eles', async () => {
    const m = memStore(); const q = fakeQuente();
    const r = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 60_000 });
    r.startTurn({ ...base, sessionId: 'q1', prompt: 'um', isNew: true });
    await until(() => m.sessions.get('q1')?.status === 'idle');
    expect(r.quentesOciosos()).toBe(1);
    r.startTurn({ ...base, sessionId: 'q1', prompt: 'dois', isNew: false });
    await until(() => m.events.filter(e => e.type === 'result').length === 2 && m.sessions.get('q1')?.status === 'idle');
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].prompts).toEqual(['um', 'dois']);
    expect(m.events.filter(e => e.type === 'user_prompt').map(e => e.payload.prompt)).toEqual(['um', 'dois']);
    expect(m.events.filter(e => e.type === 'interrupted' || e.type === 'error')).toEqual([]);
    expect(q.calls[0].fechado).toBe(false); // continua quente
    await r.stop('q1');
    await until(() => q.calls[0].fechado);
  });

  it('ocioso por quenteMs fecha o processo; a próxima mensagem sobe outro query() com resume', async () => {
    const m = memStore(); const q = fakeQuente();
    const r = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 30 });
    r.startTurn({ ...base, sessionId: 'q2', prompt: 'um', isNew: true });
    await until(() => m.sessions.get('q2')?.status === 'idle');
    await until(() => q.calls[0].fechado, 1000);
    expect(r.quentesOciosos()).toBe(0);
    r.startTurn({ ...base, sessionId: 'q2', prompt: 'dois', isNew: false });
    await until(() => q.calls.length === 2 && m.events.filter(e => e.type === 'result').length === 2);
    expect(q.calls[1].options.resume).toBe('q2');
    expect(q.calls[1].prompts).toEqual(['dois']);
    await r.stop('q2');
  });

  it('teto de ociosos: com maxQuentes=1, a 2ª sessão ociosa fecha a 1ª', async () => {
    const m = memStore(); const q = fakeQuente();
    const r = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 60_000, maxQuentes: 1 });
    r.startTurn({ ...base, sessionId: 'a', prompt: 'um', isNew: true });
    await until(() => m.sessions.get('a')?.status === 'idle');
    r.startTurn({ ...base, sessionId: 'b', prompt: 'um', isNew: true });
    await until(() => m.sessions.get('b')?.status === 'idle');
    await until(() => q.calls[0].fechado, 1000);
    expect(q.calls[1].fechado).toBe(false);
    expect(r.quentesOciosos()).toBe(1);
    await r.stop('b');
  });

  it('Parar com o processo quente ocioso só fecha: nenhum evento "interrupted" e status segue idle', async () => {
    const m = memStore(); const q = fakeQuente();
    const r = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 60_000 });
    r.startTurn({ ...base, sessionId: 'q4', prompt: 'um', isNew: true });
    await until(() => m.sessions.get('q4')?.status === 'idle');
    await r.stop('q4');
    await until(() => q.calls[0].fechado, 1000);
    await wait(20);
    expect(m.events.filter(e => e.type === 'interrupted' || e.type === 'error')).toEqual([]);
    expect(m.sessions.get('q4')?.status).toBe('idle');
    expect(r.quentesOciosos()).toBe(0);
  });

  it('cutucão (turno sem texto) vai pelo mesmo processo, uma vez só', async () => {
    const m = memStore(); const q = fakeQuente({ result: '' });
    const r = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 60_000 });
    r.startTurn({ ...base, sessionId: 'q5', prompt: '[Danilo] faz', isNew: true });
    await until(() => m.events.filter(e => e.type === 'result').length === 2 && m.sessions.get('q5')?.status === 'idle');
    await wait(30);
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].prompts).toEqual(['[Danilo] faz', `[Orion] ${CUTUCAO}`]);
    expect(m.events.filter(e => e.type === 'result').length).toBe(2);
    await r.stop('q5');
  });

  it('turno novo com modo/modelo diferentes aplica ao vivo no processo (control methods), sem subir outro', async () => {
    const m = memStore(); const q = fakeQuente({ liveControls: true });
    const r = new Runner({ queryFn: q.fn, store: m.store, quenteMs: 60_000 });
    r.startTurn({ ...base, sessionId: 'q6', prompt: 'um', isNew: true, model: 'sonnet' });
    await until(() => m.sessions.get('q6')?.status === 'idle');
    r.startTurn({ ...base, sessionId: 'q6', prompt: 'dois', isNew: false, permissionMode: 'auto', model: 'opus', effort: 'high' });
    await until(() => m.events.filter(e => e.type === 'result').length === 2);
    expect(q.calls.length).toBe(1);
    expect(q.liveCalls).toEqual([
      { type: 'setPermissionMode', mode: 'auto' },
      { type: 'setModel', model: 'opus' },
      { type: 'applyFlagSettings', settings: { effortLevel: 'high' } },
    ]);
    // mesmo valor de novo: nada chamado
    r.startTurn({ ...base, sessionId: 'q6', prompt: 'tres', isNew: false, permissionMode: 'auto', model: 'opus', effort: 'high' });
    await until(() => m.events.filter(e => e.type === 'result').length === 3);
    expect(q.liveCalls.length).toBe(3);
    await r.stop('q6');
  });

  it('mensagem durante o turno (processo quente) continua entrando no bolo pela entrada viva', async () => {
    const m = memStore(); const recebidas: string[] = [];
    let soltar!: () => void; const preso = new Promise<void>(r => { soltar = r; });
    const fn: QueryFn = ({ prompt }) => (async function* () {
      const it = (prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
      recebidas.push((await it.next()).value.message.content);
      yield { type: 'system', subtype: 'init', model: 'x' } as any;
      await preso;
      recebidas.push((await it.next()).value.message.content);
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, queued_turn_count: 0 } as any;
      await it.next(); // fica quente esperando; o teste fecha com stop()
    })() as any;
    const r = new Runner({ queryFn: fn, store: m.store, quenteMs: 60_000 });
    r.startTurn({ ...base, sessionId: 'q7', prompt: 'um', isNew: true });
    await until(() => r.status('q7') === 'running' && recebidas.length === 1);
    r.startTurn({ ...base, sessionId: 'q7', prompt: 'dois', isNew: false });
    soltar();
    await until(() => m.sessions.get('q7')?.status === 'idle');
    expect(recebidas).toEqual(['um', 'dois']);
    await r.stop('q7');
  });
});
