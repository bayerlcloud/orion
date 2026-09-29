import { describe, it, expect } from 'vitest';
import { extractAuthUrl, extractToken, stripAnsi, wantsCode, looksLikeError } from '../server/claude/loginParse';
import { LoginFlow } from '../server/claude/login';

const SAIDA = '\x1b[?25l\x1b[2K Browser didn\'t open? Use the url below to sign in (c to copy)\n\x1b[36mhttps://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=J2Iv_KEbBFe0kG6vUTck8&code_challenge_method=S256&state=v5GW7aT\x1b[0m\r\n\nPaste code here if prompted > \x1b[?25h';

describe('parse do setup-token', () => {
  it('tira códigos ANSI', () => { expect(stripAnsi('\x1b[36mabc\x1b[0m\r\n')).toBe('abc\n'); });
  it('acha a URL de autorização inteira', () => {
    const u = extractAuthUrl(SAIDA)!;
    expect(u.startsWith('https://claude.com/cai/oauth/authorize?code=true')).toBe(true);
    expect(u.endsWith('state=v5GW7aT')).toBe(true);
    expect(u).not.toContain('\x1b');
  });
  it('detecta o prompt do código', () => { expect(wantsCode(SAIDA)).toBe(true); expect(wantsCode('nada')).toBe(false); });
  it('acha o token mesmo quebrado em linhas e com ANSI', () => {
    const tok = 'sk-ant-oat01-' + 'A'.repeat(40) + '_-' + 'b'.repeat(20);
    expect(extractToken(`Your token:\n\x1b[1m${tok.slice(0, 30)}\n${tok.slice(30)}\x1b[0m\n`)).toBe(tok);
    expect(extractToken('sem token aqui')).toBeNull();
  });
  it('reconhece erro de código inválido', () => { expect(looksLikeError('boom Invalid code, try again')).toMatch(/Invalid code/); expect(looksLikeError('tudo certo')).toBeNull(); });
});

// Polling com prazo folgado: sob carga (build da fila rodando os testes em paralelo), o spawn do
// shell falso pode passar dos 3 s que o laço antigo esperava, e o teste falhava por acaso.
async function enquanto(cond: () => boolean, ms = 10000): Promise<void> {
  const fim = Date.now() + ms;
  while (cond() && Date.now() < fim) await new Promise(r => setTimeout(r, 30));
}

describe('LoginFlow com um comando falso', { timeout: 30000 }, () => {
  it('captura a URL, recebe o código, salva o token e termina', async () => {
    const saved: string[] = [];
    const tok = 'sk-ant-oat01-' + 'x'.repeat(60);
    const fake = `printf 'Use the url below\\nhttps://claude.com/cai/oauth/authorize?code=true&state=1\\nPaste code here if prompted > '; read c; printf 'Your token: ${tok}\\n'`;
    const f = new LoginFlow({ onToken: async (t) => { saved.push(t); }, command: fake, timeoutMs: 15000 });
    f.start();
    await enquanto(() => !f.url);
    expect(f.state).toBe('awaiting_code'); expect(f.url).toContain('oauth/authorize');
    expect(f.submitCode('abc123')).toBe(true);
    await enquanto(() => f.state !== 'done' && f.state !== 'error');
    expect(f.state).toBe('done'); expect(saved).toEqual([tok]);
    expect(f.snapshot().output_tail).not.toContain('\x1b');
  });
  it('sem token na saída vira erro, e cancelar funciona', async () => {
    const f = new LoginFlow({ onToken: async () => {}, command: `printf 'https://claude.com/cai/oauth/authorize?x=1\\nPaste code here if prompted > '; read c; echo 'Invalid code'`, timeoutMs: 15000 });
    f.start();
    await enquanto(() => !f.url);
    f.submitCode('errado');
    await enquanto(() => f.state === 'exchanging');
    expect(f.state).toBe('error'); expect(f.error).toMatch(/Invalid code|sem token/);
    const g = new LoginFlow({ onToken: async () => {}, command: 'sleep 5', timeoutMs: 15000 });
    g.start(); g.cancel('teste'); expect(g.state).toBe('error'); expect(g.error).toBe('teste');
  });

  it('login concluído sem token na tela cai pro arquivo de credenciais (onFileAuth, não onToken)', async () => {
    const tokenSaves: string[] = [];
    let fileAuthCalled = false;
    const f = new LoginFlow({
      onToken: async (t) => { tokenSaves.push(t); },
      onFileAuth: async () => { fileAuthCalled = true; },
      readCredentialsFallback: async () => 'algum-access-token-do-arquivo',
      command: `printf 'Opening browser to sign in\\xe2\\x80\\xa6\\nhttps://claude.com/cai/oauth/authorize?code=true&scope=user%3Aprofile&state=1\\nPaste code here if prompted > '; read c; printf 'Login successful\\n'`,
      timeoutMs: 15000,
    });
    f.start();
    await enquanto(() => !f.url);
    expect(f.state).toBe('awaiting_code');
    f.submitCode('abc123');
    await enquanto(() => f.state !== 'done' && f.state !== 'error');
    expect(f.state).toBe('done');
    expect(fileAuthCalled).toBe(true);
    expect(tokenSaves).toEqual([]); // nunca guarda um snapshot estático nesse caminho
    expect(f.token).toBeNull();
  });

  it('login concluído sem token na tela e sem arquivo de credenciais vira erro (não trava em sucesso falso)', async () => {
    const f = new LoginFlow({
      onToken: async () => {},
      readCredentialsFallback: async () => null,
      command: `printf 'https://claude.com/cai/oauth/authorize?code=true&state=1\\nPaste code here if prompted > '; read c; printf 'terminou\\n'`,
      timeoutMs: 15000,
    });
    f.start();
    await enquanto(() => !f.url);
    f.submitCode('abc123');
    await enquanto(() => f.state !== 'done' && f.state !== 'error');
    expect(f.state).toBe('error');
  });
});
