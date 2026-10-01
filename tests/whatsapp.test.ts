import { describe, expect, it } from 'vitest';
import { lerEventoMensagem } from '../server/whatsapp.js';

describe('webhook da Evolution: messages.upsert', () => {
  it('lê mensagem recebida', () => {
    const m = lerEventoMensagem({ event: 'messages.upsert', instance: 'DANILO-BAYERL-IA-ORION', data: { key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'ABC' }, pushName: 'Laís', message: { conversation: 'oi' }, messageType: 'conversation', messageTimestamp: 1790000000 } })!;
    expect(m).toMatchObject({ instancia: 'DANILO-BAYERL-IA-ORION', direcao: 'entra', remoto: '5511999990000', nome: 'Laís', texto: 'oi', msg_id: 'ABC' });
    expect(m.ts.getTime()).toBe(1790000000 * 1000);
  });
  it('mensagem enviada (fromMe) vira saída; texto estendido e legenda', () => {
    expect(lerEventoMensagem({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: '55@s', fromMe: true, id: 'X' }, message: { extendedTextMessage: { text: 'link' } } } })).toMatchObject({ direcao: 'sai', texto: 'link', nome: '' });
    expect(lerEventoMensagem({ event: 'messages.upsert', data: { key: { remoteJid: '55@s', id: 'Y' }, message: { imageMessage: { caption: 'foto' } } } })?.texto).toBe('foto');
  });
  it('send.message (enviada pela API) também conta', () => {
    expect(lerEventoMensagem({ event: 'send.message', data: { key: { remoteJid: '55@s', fromMe: true, id: 'Z' }, message: { conversation: 'teste' } } })).toMatchObject({ direcao: 'sai', texto: 'teste' });
  });
  it('ignora outros eventos e mensagem sem chave', () => {
    expect(lerEventoMensagem({ event: 'connection.update', data: {} })).toBeNull();
    expect(lerEventoMensagem({ event: 'messages.upsert', data: {} })).toBeNull();
    expect(lerEventoMensagem(null)).toBeNull();
  });
});
