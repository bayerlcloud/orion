import { describe, expect, it } from 'vitest';
import { cloudflareMcpServers, cloudflareParaHeader, looksLikeCloudflareAccountId, looksLikeCloudflareToken, nomeMcpCloudflare } from '../server/tools/cloudflareAccounts.js';
import { buildSystemAppend } from '../server/claude/header.js';

describe('contas Cloudflare (aba Tools)', () => {
  it('aceita token de conta, de usuário e o formato antigo; rejeita o resto', () => {
    expect(looksLikeCloudflareToken('cfat_' + 'a'.repeat(40))).toBe(true);
    expect(looksLikeCloudflareToken('cfut_' + 'b'.repeat(40))).toBe(true);
    expect(looksLikeCloudflareToken('x'.repeat(40))).toBe(true);
    expect(looksLikeCloudflareToken('sk-ant-xxx')).toBe(false);
    expect(looksLikeCloudflareToken('')).toBe(false);
    expect(looksLikeCloudflareAccountId('8df20ec9123ba639635d8abee659e55f')).toBe(true);
    expect(looksLikeCloudflareAccountId('abc')).toBe(false);
  });
  it('nome do MCP é cloudflare-<slug do label>', () => {
    expect(nomeMcpCloudflare('fisioexpert')).toBe('cloudflare-fisioexpert');
    expect(nomeMcpCloudflare('Tracking Machine!')).toBe('cloudflare-tracking-machine');
    expect(nomeMcpCloudflare('')).toBe('cloudflare-conta');
  });
  it('um MCP remoto oficial por conta, com Bearer; nenhum sem contas', () => {
    expect(cloudflareMcpServers([])).toEqual({});
    const s = cloudflareMcpServers([{ label: 'fisioexpert', token: 'cfat_x' }, { label: 'ralab', token: 'cfat_y' }]);
    expect(Object.keys(s)).toEqual(['cloudflare-fisioexpert', 'cloudflare-ralab']);
    expect(s['cloudflare-ralab']).toEqual({ type: 'http', url: 'https://bindings.mcp.cloudflare.com/mcp', headers: { Authorization: 'Bearer cfat_y' } });
  });
  it('a explicação de cada conta entra no header da sessão', () => {
    const cloudflare = cloudflareParaHeader([{ id: 1, label: 'fisioexpert', account_id: '8df20ec9123ba639635d8abee659e55f', account_name: "Fisioexpertapp@gmail.com's Account", email: 'fisioexpertapp@gmail.com', token: 'cfat_x', notes: 'Pages fisio.bayerl.cloud' }]);
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cloudflare });
    expect(txt).toContain('- cloudflare-fisioexpert (account 8df20ec9123ba639635d8abee659e55f, e-mail fisioexpertapp@gmail.com): Pages fisio.bayerl.cloud');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', cloudflare: [] })).not.toContain('Contas Cloudflare');
  });
});
