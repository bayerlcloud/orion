import { describe, expect, it } from 'vitest';
import { bloqueadoNoConector, cloudflareParaHeader, contaDoConector, ehPedidoLocal, looksLikeCloudflareAccountId, looksLikeCloudflareToken, nomeConectorCloudflare, urlDoConector, type CloudflareAccount } from '../server/tools/cloudflareAccounts.js';
import { buildSystemAppend } from '../server/claude/header.js';

const fisio: CloudflareAccount = { id: 1, label: 'fisioexpert', account_id: '8df20ec9123ba639635d8abee659e55f', account_name: "Fisioexpertapp@gmail.com's Account", email: 'fisioexpertapp@gmail.com', token: 'cfat_x', notes: 'Pages fisio.bayerl.cloud' };

describe('contas Cloudflare (conector simples)', () => {
  it('aceita token de conta, de usuário e o formato antigo; rejeita o resto', () => {
    expect(looksLikeCloudflareToken('cfat_' + 'a'.repeat(40))).toBe(true);
    expect(looksLikeCloudflareToken('cfut_' + 'b'.repeat(40))).toBe(true);
    expect(looksLikeCloudflareToken('x'.repeat(40))).toBe(true);
    expect(looksLikeCloudflareToken('sk-ant-xxx')).toBe(false);
    expect(looksLikeCloudflareToken('')).toBe(false);
    expect(looksLikeCloudflareAccountId('8df20ec9123ba639635d8abee659e55f')).toBe(true);
    expect(looksLikeCloudflareAccountId('abc')).toBe(false);
  });
  it('nome do conector é cloudflare-<slug do label> e a URL é o proxy local', () => {
    expect(nomeConectorCloudflare('fisioexpert')).toBe('cloudflare-fisioexpert');
    expect(nomeConectorCloudflare('Tracking Machine!')).toBe('cloudflare-tracking-machine');
    expect(nomeConectorCloudflare('')).toBe('cloudflare-conta');
    expect(urlDoConector('cloudflare-ralab')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/conector\/cloudflare-ralab$/);
    expect(contaDoConector('cloudflare-fisioexpert', [fisio])).toBe(fisio);
    expect(contaDoConector('cloudflare-outra', [fisio])).toBeNull();
  });
  it('só pedido local direto passa: loopback e sem X-Forwarded-For (o Caddy sempre põe)', () => {
    expect(ehPedidoLocal('127.0.0.1', undefined)).toBe(true);
    expect(ehPedidoLocal('::ffff:127.0.0.1', undefined)).toBe(true);
    expect(ehPedidoLocal('127.0.0.1', '203.0.113.9')).toBe(false);
    expect(ehPedidoLocal('10.0.0.5', undefined)).toBe(false);
  });
  it('bloqueia só apagar zona ou projeto Pages inteiro', () => {
    expect(bloqueadoNoConector('DELETE', 'zones/' + 'a'.repeat(32))).toBe(true);
    expect(bloqueadoNoConector('DELETE', 'accounts/' + 'a'.repeat(32) + '/pages/projects/fisio')).toBe(true);
    expect(bloqueadoNoConector('DELETE', 'zones/' + 'a'.repeat(32) + '/dns_records/' + 'b'.repeat(32))).toBe(false);
    expect(bloqueadoNoConector('GET', 'zones/' + 'a'.repeat(32))).toBe(false);
  });
  it('a URL do proxy e a explicação de cada conta entram no header da sessão', () => {
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cloudflare: cloudflareParaHeader([fisio]) });
    expect(txt).toContain('- cloudflare-fisioexpert: ' + urlDoConector('cloudflare-fisioexpert') + ' (account 8df20ec9123ba639635d8abee659e55f, e-mail fisioexpertapp@gmail.com): Pages fisio.bayerl.cloud');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cloudflare: [] })).not.toContain('Contas Cloudflare');
  });
});

describe('cabeçalho da sessão neutra', () => {
  it('sessão sem projeto se apresenta como neutra; com projeto avisa que o projeto não muda', () => {
    expect(buildSystemAppend({ projectName: null, projectPath: '/home/danilo/neutro', createdBy: 'Danilo' })).toContain('sessão neutra, sem projeto');
    expect(buildSystemAppend({ projectName: 'Orion', projectPath: '/srv/orion', createdBy: 'Danilo' })).toContain('O projeto de uma sessão não muda');
  });
});
