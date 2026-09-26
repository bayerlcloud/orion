import { describe, it, expect } from 'vitest';
import { applyLive, emptyLive, fromRows, toConvEvents } from '../web/src/claude/live';

describe('fromRows', () => {
  it('reconstrói prompt, mensagens e pendência do servidor', () => {
    const s = fromRows([
      { seq: 1, type: 'user_prompt', payload: { prompt: '[Danilo] oi' } },
      { seq: 2, type: 'system', payload: { type: 'system', subtype: 'init', model: 'm' } },
      { seq: 3, type: 'assistant', payload: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } } },
      { seq: 4, type: 'permission_request', payload: { id: 'p1', toolName: 'Bash', input: { command: 'rm x' } } },
      { seq: 5, type: 'permission_request', payload: { id: 'p0', toolName: 'Bash', input: {} } },
      { seq: 6, type: 'permission_resolved', payload: { id: 'p0', decision: 'allow' } },
    ], 'waiting', [{ id: 'p1', toolName: 'Bash' }]);
    expect(s.messages.map(m => m.type)).toEqual(['user', 'system', 'assistant']);
    expect(s.pending.map(p => p.id)).toEqual(['p1']);
    const ev = toConvEvents(s);
    // p0 (resolvida) aparece antes de p1 (pendente) — permissões resolvidas não somem mais
    expect(ev.map(e => e.kind)).toEqual(['user', 'system', 'tool', 'permission', 'permission']);
    const pend = ev.find(e => e.kind === 'permission' && !e.decision);
    expect(pend && pend.kind === 'permission' && pend.inputText).toBe('rm x');
    const resolvida = ev.find(e => e.kind === 'permission' && e.decision === 'allow');
    expect(!!resolvida).toBe(true);
  });
  it('erro persistido só aparece se o status atual é error', () => {
    const rows = [{ seq: 1, type: 'error', payload: { message: 'sem login' } }];
    expect(toConvEvents(fromRows(rows, 'error', [])).at(-1)).toMatchObject({ kind: 'result', ok: false, error: 'sem login' });
    expect(toConvEvents(fromRows(rows, 'idle', []))).toEqual([]);
  });
});

describe('applyLive', () => {
  it('acumula parciais de texto e pensamento e limpa quando a mensagem completa chega', () => {
    let s = emptyLive();
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pen' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'sando' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ol' } } });
    s = applyLive(s, { type: 'partial', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'á' } } });
    expect(s.partialThinking).toBe('pensando'); expect(s.partialText).toBe('olá');
    const ev = toConvEvents(s);
    expect(ev.map(e => e.kind)).toEqual(['thinking', 'text']);
    expect(ev[1].kind === 'text' && ev[1].streaming).toBe(true);
    s = applyLive(s, { type: 'message', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'olá' }] } } });
    expect(s.partialText).toBe(''); expect(s.partialThinking).toBe('');
    expect(toConvEvents(s).map(e => e.kind)).toEqual(['text']);
  });
  it('não duplica o eco do prompt', () => {
    let s = applyLive(emptyLive(), { type: 'message', message: { type: 'user', message: { content: '[D] oi' } } });
    s = applyLive(s, { type: 'message', message: { type: 'user', message: { content: '[D] oi' } } });
    expect(s.messages).toHaveLength(1);
  });
  it('permissão entra, muda status e sai quando resolvida', () => {
    let s = applyLive(emptyLive(), { type: 'permission_request', id: 'p', toolName: 'Bash', input: { command: 'x' }, hasSuggestions: true });
    expect(s.status).toBe('waiting'); expect(s.pending).toHaveLength(1);
    s = applyLive(s, { type: 'permission_request', id: 'p', toolName: 'Bash', input: {}, hasSuggestions: true });
    expect(s.pending).toHaveLength(1);
    s = applyLive(s, { type: 'permission_resolved', id: 'p', decision: 'allow' });
    expect(s.pending).toHaveLength(0);
  });
  it('hello traz status e pendências mantendo o input já conhecido', () => {
    let s = applyLive(emptyLive(), { type: 'permission_request', id: 'p', toolName: 'Bash', input: { command: 'x' }, hasSuggestions: false });
    s = applyLive(s, { type: 'hello', status: 'waiting', pending: [{ id: 'p', toolName: 'Bash' }] });
    expect(s.pending[0].input).toEqual({ command: 'x' });
  });
  it('erro aparece e some ao voltar a rodar', () => {
    let s = applyLive(emptyLive(), { type: 'error', message: 'boom' });
    s = applyLive(s, { type: 'status', status: 'error' });
    expect(toConvEvents(s).at(-1)).toMatchObject({ kind: 'result', ok: false });
    s = applyLive(s, { type: 'status', status: 'running' });
    expect(s.error).toBeNull();
  });
  it('evento desconhecido não altera nada', () => {
    const s = emptyLive();
    expect(applyLive(s, { type: 'zzz' })).toBe(s);
  });
});
