import { describe, expect, it } from 'vitest';
import { normalizeUrl, parseMd, promptFromMd } from '../web/src/claude/rich';
import { applyLive, emptyLive, fromRows } from '../web/src/claude/live';

describe('campo de prompt com formatação', () => {
  it('link vai para o Claude como "texto (url)"', () => {
    expect(promptFromMd('veja [o site](https://a.com/x) e **isso**')).toBe('veja o site (https://a.com/x) e **isso**');
    expect(promptFromMd('[https://a.com](https://a.com)')).toBe('https://a.com');
  });

  it('lê listas, negrito, itálico e link do markdown', () => {
    const l = parseMd('- um **forte**\n1. dois\ntexto *it* [l](https://b.io)\n2 * 3 * 4');
    expect(l[0]).toEqual({ list: 'ul', inl: [{ kind: 'text', text: 'um ' }, { kind: 'b', text: 'forte' }] });
    expect(l[1].list).toBe('ol');
    expect(l[2].inl.map(i => i.kind)).toEqual(['text', 'i', 'text', 'a']);
    expect(l[3].inl).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
  });

  it('só aceita link http(s)', () => {
    expect(normalizeUrl('exemplo.com/a')).toBe('https://exemplo.com/a');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('dois termos')).toBeNull();
    expect(parseMd('[x](javascript:alert(1))')[0].inl[0].kind).toBe('text');
  });

  it('sugestão de prompt chega, volta do histórico e some ao rodar', () => {
    let s = applyLive(emptyLive(), { type: 'suggestion', suggestion: 'roda os testes' });
    expect(s.suggestion).toBe('roda os testes');
    s = applyLive(s, { type: 'status', status: 'running' });
    expect(s.suggestion).toBeNull();
    const r = fromRows([{ seq: 1, type: 'user_prompt', payload: { prompt: 'oi' } }, { seq: 2, type: 'prompt_suggestion', payload: { suggestion: 'e agora?' } }], 'idle', []);
    expect(r.suggestion).toBe('e agora?');
  });
});
