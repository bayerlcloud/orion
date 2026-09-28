import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// os.homedir() respeita $HOME no POSIX — isola cada teste num HOME temporário, sem mexer no
// diretório real do usuário que roda os testes.
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
  // importa depois de trocar HOME, e sem cache de módulo entre os testes (credentialsPath() lê
  // homedir() a cada chamada, então nem precisa re-importar — só reforça a intenção aqui).
  const mod = await import('../server/claude/credentialsFile');
  return mod;
}

describe('readClaudeCredentials', () => {
  it('lê o accessToken de um arquivo de credenciais válido', async () => {
    const { readClaudeCredentials } = await withFakeHome({ claudeAiOauth: { accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: 999 } });
    const c = await readClaudeCredentials();
    expect(c).toEqual({ accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: 999 });
  });
  it('sem arquivo, devolve null (nunca lança)', async () => {
    const { readClaudeCredentials } = await withFakeHome(null);
    expect(await readClaudeCredentials()).toBeNull();
  });
  it('arquivo sem claudeAiOauth.accessToken devolve null', async () => {
    const { readClaudeCredentials } = await withFakeHome({ someOtherKey: true });
    expect(await readClaudeCredentials()).toBeNull();
  });
  it('JSON inválido devolve null em vez de lançar', async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'orion-creds-'));
    process.env.HOME = tmpHome;
    await mkdir(join(tmpHome, '.claude'), { recursive: true });
    await writeFile(join(tmpHome, '.claude', '.credentials.json'), '{ isso não é json');
    const { readClaudeCredentials } = await import('../server/claude/credentialsFile');
    expect(await readClaudeCredentials()).toBeNull();
  });
});
