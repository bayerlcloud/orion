import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTokenExpired, refreshAccessToken } from '../server/claude/credentialsFile';

let tmpHome: string | null = null;
const realHome = process.env.HOME;
afterEach(async () => {
  process.env.HOME = realHome;
  if (tmpHome) { await rm(tmpHome, { recursive: true, force: true }); tmpHome = null; }
});

async function withFakeHome(credentials: unknown | null) {
  tmpHome = await mkdtemp(join(tmpdir(), 'orion-creds-'));
  process.env.HOME = tmpHome;
  if (credentials !== null) {
    await mkdir(join(tmpHome, '.claude'), { recursive: true });
    await writeFile(join(tmpHome, '.claude', '.credentials.json'), JSON.stringify(credentials));
  }
  const mod = await import('../server/claude/credentialsFile');
  return mod;
}

describe('readClaudeCredentials — agora também lê scopes', () => {
  it('lê accessToken/refreshToken/expiresAt/scopes de um arquivo válido', async () => {
    const { readClaudeCredentials } = await withFakeHome({ claudeAiOauth: { accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: 999, scopes: ['user:profile', 'user:inference'] } });
    const c = await readClaudeCredentials();
    expect(c).toEqual({ accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: 999, scopes: ['user:profile', 'user:inference'] });
  });
  it('sem scopes no arquivo, devolve undefined (nunca inventa um array vazio como se fosse dado real)', async () => {
    const { readClaudeCredentials } = await withFakeHome({ claudeAiOauth: { accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: 999 } });
    const c = await readClaudeCredentials();
    expect(c?.scopes).toBeUndefined();
  });
});

describe('isTokenExpired', () => {
  it('sem expiresAt: trata como expirado (nunca assume válido sem saber a validade — mais seguro forçar refresh)', () => {
    expect(isTokenExpired(undefined, 1000)).toBe(true);
  });
  it('expiresAt no futuro, fora da margem: não expirado', () => {
    expect(isTokenExpired(100_000, 1000, 60_000)).toBe(false);
  });
  it('expiresAt no passado: expirado', () => {
    expect(isTokenExpired(500, 1000, 60_000)).toBe(true);
  });
  it('expiresAt no futuro mas dentro da margem de segurança: já conta como expirado (evita usar um token que morre no meio da chamada)', () => {
    expect(isTokenExpired(1000 + 30_000, 1000, 60_000)).toBe(true);
  });
});

describe('refreshAccessToken — chamada real ao endpoint OAuth (fetch injetado, sem rede de verdade)', () => {
  const creds = { refreshToken: 'ref-abc', scopes: ['user:profile', 'user:inference'] };
  it('200 com token novo: devolve accessToken/refreshToken/expiresAt normalizados (expiresAt = agora + expires_in*1000)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: 'novo-tok', refresh_token: 'novo-ref', expires_in: 3600, scope: 'user:profile user:inference' }) });
    const out = await refreshAccessToken(creds, { fetchImpl, now: () => 1_000_000 });
    expect(out).toEqual({ accessToken: 'novo-tok', refreshToken: 'novo-ref', expiresAt: 1_000_000 + 3_600_000 });
  });
  it('resposta sem refresh_token novo: reaproveita o refreshToken antigo (rotação nem sempre reemite um novo)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: 'novo-tok', expires_in: 3600 }) });
    const out = await refreshAccessToken(creds, { fetchImpl, now: () => 0 });
    expect(out?.refreshToken).toBe('ref-abc');
  });
  it('manda o corpo exato esperado pelo endpoint real (grant_type/client_id/scope confirmados no bundle da extensão real)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 10 }) });
    await refreshAccessToken(creds, { fetchImpl, now: () => 0 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ grant_type: 'refresh_token', refresh_token: 'ref-abc', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:profile user:inference' });
  });
  it('resposta não-200: null, nunca lança', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    expect(await refreshAccessToken(creds, { fetchImpl, now: () => 0 })).toBeNull();
  });
  it('fetch lança (rede fora): null, nunca propaga a exceção', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    expect(await refreshAccessToken(creds, { fetchImpl, now: () => 0 })).toBeNull();
  });
  it('sem refreshToken: null sem nem tentar chamar a rede', async () => {
    const fetchImpl = vi.fn();
    expect(await refreshAccessToken({ refreshToken: undefined, scopes: [] }, { fetchImpl, now: () => 0 })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('getValidAccessToken — orquestra leitura + refresh-se-preciso + persiste de volta no arquivo', () => {
  it('token ainda válido: devolve ele direto, sem chamar a rede', async () => {
    const { getValidAccessToken } = await withFakeHome({ claudeAiOauth: { accessToken: 'tok-valido', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000, scopes: ['user:profile'] } });
    const fetchImpl = vi.fn();
    const tok = await getValidAccessToken({ fetchImpl });
    expect(tok).toBe('tok-valido');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('token expirado: renova, PERSISTE de volta no arquivo (preservando as outras chaves) e devolve o novo', async () => {
    const { getValidAccessToken } = await withFakeHome({
      claudeAiOauth: { accessToken: 'tok-velho', refreshToken: 'ref-velho', expiresAt: 1, scopes: ['user:profile'], subscriptionType: 'max' },
      mcpOAuth: { algumServidor: 'nao mexer' },
    });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: 'tok-novo', refresh_token: 'ref-novo', expires_in: 3600 }) });
    const tok = await getValidAccessToken({ fetchImpl });
    expect(tok).toBe('tok-novo');
    const onDisk = JSON.parse(await readFile(join(tmpHome!, '.claude', '.credentials.json'), 'utf8'));
    expect(onDisk.claudeAiOauth.accessToken).toBe('tok-novo');
    expect(onDisk.claudeAiOauth.refreshToken).toBe('ref-novo');
    expect(onDisk.claudeAiOauth.subscriptionType).toBe('max');
    expect(onDisk.mcpOAuth).toEqual({ algumServidor: 'nao mexer' });
  });
  it('token expirado e refresh falha (refreshToken também morto): devolve null, arquivo original intacto', async () => {
    const { getValidAccessToken } = await withFakeHome({ claudeAiOauth: { accessToken: 'tok-velho', refreshToken: 'ref-velho', expiresAt: 1 } });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const tok = await getValidAccessToken({ fetchImpl });
    expect(tok).toBeNull();
    const onDisk = JSON.parse(await readFile(join(tmpHome!, '.claude', '.credentials.json'), 'utf8'));
    expect(onDisk.claudeAiOauth.accessToken).toBe('tok-velho');
  });
  it('sem arquivo de credenciais nenhum: null', async () => {
    const { getValidAccessToken } = await withFakeHome(null);
    expect(await getValidAccessToken({ fetchImpl: vi.fn() })).toBeNull();
  });
});
