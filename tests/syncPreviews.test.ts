import { describe, it, expect } from 'vitest';
import { blocoCaddy, hostsComBloco, registrosFaltando } from '../server/preview/sync';

const row = (user_id: number | null, host: string, port: number) => ({ id: 1, project_id: 1, user_id, host, port, worktree_path: '/srv/projects/fisio' });

describe('blocoCaddy', () => {
  it('pessoal tem forward_auth e __orion_auth antes do proxy', () => {
    const b = blocoCaddy(row(1, 'danilo.fisio.bayerl.cloud', 9101));
    expect(b).toContain('danilo.fisio.bayerl.cloud {');
    expect(b).toContain('forward_auth 127.0.0.1:3000');
    expect(b).toContain('handle /__orion_auth');
    expect(b.indexOf('/__orion_auth')).toBeLessThan(b.indexOf('forward_auth'));
    expect(b.indexOf('forward_auth')).toBeLessThan(b.indexOf('reverse_proxy 127.0.0.1:9101'));
    expect(b).toContain('route {');
  });
  it('raiz é público, sem auth', () => {
    const b = blocoCaddy(row(null, 'fisio.bayerl.cloud', 9100));
    expect(b).not.toContain('forward_auth');
    expect(b).not.toContain('__orion_auth');
    expect(b).toContain('reverse_proxy 127.0.0.1:9100');
  });
  it('os dois bloqueiam caminhos perigosos com matchers separados', () => {
    for (const b of [blocoCaddy(row(1, 'a.b.bayerl.cloud', 9101)), blocoCaddy(row(null, 'b.bayerl.cloud', 9100))]) {
      expect(b).toContain('@bloqueado path /@fs* */.env* */.git*');
      expect(b).toContain('respond @bloqueado 404');
      expect(b).toContain('respond @queryRuim 404');
      expect(b).toContain('header_up Host "localhost"');
    }
  });
});

describe('registrosFaltando', () => {
  it('cria só onde não há A; A para outro IP vira conflito, sem mexer', () => {
    const zona = [
      { name: 'fisio', type: 'A', records: [{ content: '217.76.55.249' }] },
      { name: 'danilo.fisio', type: 'A', records: [{ content: '86.48.28.10' }] },
      { name: 'lais.fisio', type: 'CNAME', records: [{ content: 'x' }] },
    ];
    expect(registrosFaltando(['fisio.bayerl.cloud', 'danilo.fisio.bayerl.cloud', 'lais.fisio.bayerl.cloud'], zona)).toEqual({ faltam: ['lais.fisio'], conflitos: ['danilo.fisio'] });
  });
});

describe('hostsComBloco', () => {
  it('tira os hosts cujo DNS aponta para outra máquina', () => {
    expect(hostsComBloco(['a.bayerl.cloud', 'b.bayerl.cloud', 'c.bayerl.cloud'], ['b'])).toEqual(['a.bayerl.cloud', 'c.bayerl.cloud']);
  });
});
