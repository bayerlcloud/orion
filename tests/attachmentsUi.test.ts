import { describe, it, expect } from 'vitest';
import { applyLive, emptyLive, fromRows, toConvEvents } from '../web/src/claude/live';
import { reduceSdkMessages } from '../web/src/claude/mapper';
import type { SdkMessage } from '../web/src/claude/types';

describe('anexos na timeline', () => {
  it('fromRows carrega os anexos do user_prompt para o evento de usuário', () => {
    const s = fromRows([
      { seq: 1, type: 'user_prompt', payload: { prompt: '[D] veja', attachments: [{ kind: 'image', name: 'x.png', media_type: 'image/png' }] } },
    ], 'idle', []);
    const ev = toConvEvents(s);
    expect(ev[0]).toMatchObject({ kind: 'user', text: '[D] veja', attachments: [{ kind: 'image', name: 'x.png' }] });
  });

  it('reduceSdkMessages preserva os anexos numa mensagem de usuário com texto simples', () => {
    const msgs: SdkMessage[] = [{ type: 'user', message: { content: '[D] veja', attachments: [{ kind: 'file', name: 'a.pdf' }] } }];
    expect(reduceSdkMessages(msgs)[0]).toMatchObject({ kind: 'user', attachments: [{ kind: 'file', name: 'a.pdf' }] });
  });

  it('eco do SDK que só acrescenta a nota de anexo é tratado como duplicata', () => {
    let s = applyLive(emptyLive(), { type: 'message', message: { type: 'user', message: { content: '[D] veja', attachments: [{ kind: 'file', name: 'a.pdf' }] } } });
    s = applyLive(s, { type: 'message', message: { type: 'user', message: { content: '[D] veja\n\n[arquivo anexado: a.pdf em /u/a.pdf — use ferramentas para lê-lo]' } } });
    expect(s.messages).toHaveLength(1);
  });

  it('prompts diferentes não são deduplicados', () => {
    let s = applyLive(emptyLive(), { type: 'message', message: { type: 'user', message: { content: '[D] um' } } });
    s = applyLive(s, { type: 'message', message: { type: 'user', message: { content: '[D] dois' } } });
    expect(s.messages).toHaveLength(2);
  });

  it('tool_result (sem texto) não é confundido com eco do prompt', () => {
    let s = applyLive(emptyLive(), { type: 'message', message: { type: 'user', message: { content: '[D] um' } } });
    s = applyLive(s, { type: 'message', message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } } });
    expect(s.messages).toHaveLength(2);
  });
});
