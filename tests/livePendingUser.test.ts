import { describe, expect, it } from 'vitest';
import { addPendingUser, applyLive, dropPendingUser, emptyLive, keepPendingUser } from '../web/src/claude/live';

const eco = (text: string) => ({ type: 'message', message: { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } });

describe('mensagem provisória do usuário', () => {
  it('aparece na hora e o eco real toma o lugar dela', () => {
    let s = addPendingUser(emptyLive(), '[Danilo] oi');
    expect(s.messages).toHaveLength(1);
    s = applyLive(s, eco('[Danilo] oi'));
    expect(s.messages).toHaveLength(1);
    expect((s.messages[0] as any)._pending).toBeUndefined();
  });
  it('falha no envio tira a provisória', () => {
    expect(dropPendingUser(addPendingUser(emptyLive(), '[Danilo] oi')).messages).toHaveLength(0);
  });
  it('recarga do histórico mantém a provisória sem eco e descarta a já ecoada', () => {
    const prev = addPendingUser(addPendingUser(emptyLive(), '[Danilo] a'), '[Danilo] b');
    const hist = applyLive(emptyLive(), eco('[Danilo] a'));
    const s = keepPendingUser(prev, hist);
    expect(s.messages.map(m => (m as any).message.content)).toEqual(['[Danilo] a', '[Danilo] b']);
  });
});
