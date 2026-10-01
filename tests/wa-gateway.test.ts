import { describe, expect, it } from 'vitest';
import { apelidoDoModo, assinatura, contatoDe, contatoDoDestino, esperaReenvio, intervaloEnvio, limparPayload, rotaPermitida } from '../server/wa/gateway.js';

describe('gateway de WhatsApp (orion-wa)', () => {
  it('libera só envio, estado, lista e leituras; o resto é 403', () => {
    expect(rotaPermitida('POST', 'message/sendText/alertas')).toEqual({ tipo: 'enviar', apelido: 'alertas', evo: 'message/sendText' });
    expect(rotaPermitida('POST', '/message/sendMedia/conversa')).toMatchObject({ tipo: 'enviar', evo: 'message/sendMedia' });
    expect(rotaPermitida('GET', 'instance/connectionState/alertas')).toEqual({ tipo: 'estado', apelido: 'alertas' });
    expect(rotaPermitida('GET', 'instance/fetchInstances')).toEqual({ tipo: 'instancias' });
    expect(rotaPermitida('GET', 'group/fetchAllGroups/alertas?getParticipants=false')).toMatchObject({ tipo: 'leitura', evo: 'group/fetchAllGroups' });
    expect(rotaPermitida('POST', 'chat/findContacts/alertas')).toMatchObject({ tipo: 'leitura' });
    for (const [m, c] of [['POST', 'instance/create'], ['DELETE', 'instance/delete/alertas'], ['GET', 'instance/connect/alertas'], ['POST', 'webhook/set/alertas'], ['GET', 'message/sendText/alertas'], ['POST', 'settings/set/alertas']])
      expect(rotaPermitida(m, c)).toBeNull();
  });
  it('contato: grupo inteiro, pessoa só dígitos, @lid usa o Alt', () => {
    expect(contatoDe('120363378318406063@g.us')).toBe('120363378318406063@g.us');
    expect(contatoDe('5511999990000@s.whatsapp.net')).toBe('5511999990000');
    expect(contatoDe('274341170298941@lid', '5511960416613@s.whatsapp.net')).toBe('5511960416613');
    expect(contatoDoDestino('+55 (11) 99999-0000')).toBe('5511999990000');
  });
  it('repasse: tira a apikey, troca instance e server_url; apelido pelo modo', () => {
    const p = limparPayload({ event: 'messages.upsert', instance: 'DANILO-BAYERL-IA-ORION', apikey: 'segredo', server_url: 'https://evo', data: { x: 1 } }, apelidoDoModo('ouvir'), 'https://orion/wa');
    expect(p).toEqual({ event: 'messages.upsert', instance: 'alertas', server_url: 'https://orion/wa', data: { x: 1 } });
    expect(apelidoDoModo('conversar')).toBe('conversa');
  });
  it('HMAC, intervalo de 3 a 8 s e espera crescente do reenvio', () => {
    expect(assinatura('s', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(intervaloEnvio(() => 0)).toBe(3000);
    expect(intervaloEnvio(() => 0.9999)).toBeLessThan(8000);
    expect(esperaReenvio(1)).toBe(10_000);
    expect(esperaReenvio(2)).toBe(30_000);
    expect(esperaReenvio(20)).toBe(3_600_000);
  });
});
