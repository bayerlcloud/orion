import { describe, it, expect } from 'vitest';
import { groupHooksByEventAndMatcher } from '../web/src/claude/mapper';
import type { HookEntry } from '../web/src/claude/types';

const h = (over: Partial<HookEntry>): HookEntry => ({
  event: 'PreToolUse', matcher: '', type: 'command', description: 'x', source: 'project', disabled: false, ...over,
});

describe('groupHooksByEventAndMatcher — pura, mesma organização visual da lista real', () => {
  it('lista vazia: nenhum grupo', () => {
    expect(groupHooksByEventAndMatcher([])).toEqual([]);
  });

  it('um evento, um matcher, um hook', () => {
    const rows = groupHooksByEventAndMatcher([h({ event: 'PreToolUse', matcher: 'Bash', description: 'echo oi' })]);
    expect(rows).toEqual([{ event: 'PreToolUse', count: 1, matchers: [{ matcher: 'Bash', hooks: [h({ event: 'PreToolUse', matcher: 'Bash', description: 'echo oi' })] }] }]);
  });

  it('mesmo evento, matchers diferentes: um grupo de evento, vários de matcher', () => {
    const rows = groupHooksByEventAndMatcher([
      h({ event: 'PreToolUse', matcher: 'Bash', description: 'a' }),
      h({ event: 'PreToolUse', matcher: 'Edit', description: 'b' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('PreToolUse');
    expect(rows[0].count).toBe(2);
    expect(rows[0].matchers.map(m => m.matcher)).toEqual(['Bash', 'Edit']);
  });

  it('eventos diferentes viram grupos separados, na ordem de primeira aparição', () => {
    const rows = groupHooksByEventAndMatcher([
      h({ event: 'Stop', description: 'z' }),
      h({ event: 'PreToolUse', description: 'a' }),
      h({ event: 'Stop', description: 'y' }),
    ]);
    expect(rows.map(r => r.event)).toEqual(['Stop', 'PreToolUse']);
    expect(rows[0].count).toBe(2);
  });

  it('matcher vazio ("") agrupa junto — representa "(all)"', () => {
    const rows = groupHooksByEventAndMatcher([
      h({ event: 'SessionStart', matcher: '', description: 'a' }),
      h({ event: 'SessionStart', matcher: '', description: 'b' }),
    ]);
    expect(rows[0].matchers).toHaveLength(1);
    expect(rows[0].matchers[0].matcher).toBe('');
    expect(rows[0].matchers[0].hooks).toHaveLength(2);
  });

  it('não muda a lista original nem os objetos hook (mesma referência dentro do grupo)', () => {
    const original = [h({ event: 'Stop', description: 'a' })];
    const rows = groupHooksByEventAndMatcher(original);
    expect(rows[0].matchers[0].hooks[0]).toBe(original[0]);
    expect(original).toHaveLength(1);
  });
});
