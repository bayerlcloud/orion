import { describe, expect, it } from 'vitest';
import { bloqueadoNoHttp, conectoresHttpParaHeader, type ConectorHttp } from '../server/tools/conectoresHttp.js';
import { buildSystemAppend } from '../server/claude/header.js';

const host: ConectorHttp = { nome: 'hostinger', base: 'https://developers.hostinger.com', header: 'Authorization', valor: 'Bearer segredo', dica: 'DNS',
  bloqueios: ['POST ^/?api/vps/v1/virtual-machines/\\d+/recreate', 'DELETE ^/?api/billing/'] };

describe('conectores HTTP genéricos (APIs REST que eram MCP)', () => {
  it('bloqueia só o que está na lista, por método e caminho', () => {
    expect(bloqueadoNoHttp(host, 'POST', 'api/vps/v1/virtual-machines/123/recreate')).toBe(true);
    expect(bloqueadoNoHttp(host, 'DELETE', 'api/billing/v1/subscriptions/9')).toBe(true);
    expect(bloqueadoNoHttp(host, 'GET', 'api/vps/v1/virtual-machines/123/recreate')).toBe(false);
    expect(bloqueadoNoHttp(host, 'DELETE', 'api/dns/v1/zones/bayerl.cloud')).toBe(false);
  });
  it('o header da sessão leva URL do proxy e dica, nunca o token', () => {
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', conectores: conectoresHttpParaHeader([host]) });
    expect(txt).toContain('/conector/hostinger');
    expect(txt).not.toContain('segredo');
  });
});
