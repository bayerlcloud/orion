import { describe, it, expect } from 'vitest';
import { renderScreenLines, tokenFromScreen, urlFromScreen } from '../server/claude/terminalScreen';

const ESC = '\x1b';
const TOKEN = 'sk-ant-oat01-' + 'REALtokenBODY_' + 'a'.repeat(60) + '-final_OK';

describe('reconstrução de tela do setup-token', () => {
  it('recupera o token mesmo com repintura por movimento de cursor', async () => {
    let raw = 'Welcome to Claude Code\r\n';
    raw += ESC + '[2K' + '  ' + TOKEN + '  ' + ESC + '[0m\r\n';
    raw += 'Token stored securely\r\n' + ESC + '[H' + ESC + '[3;3H' + 'x';
    expect(await tokenFromScreen(raw)).toBe(TOKEN);
  });
  it('não confunde o token com a palavra vizinha (regressão do bug "…curely")', async () => {
    // token seguido, sem espaço no fluxo achatado, da frase de sucesso
    const raw = ESC + '[2K' + TOKEN + '\r\nstored securely now';
    const got = await tokenFromScreen(raw);
    expect(got).toBe(TOKEN);
    expect(got!.endsWith('curely')).toBe(false);
  });
  it('acha a URL de autorização em linha própria', async () => {
    const raw = 'use the url below\r\n' + ESC + '[36m' + 'https://claude.com/cai/oauth/authorize?code=true&state=abc' + ESC + '[0m\r\n';
    expect(await urlFromScreen(raw)).toBe('https://claude.com/cai/oauth/authorize?code=true&state=abc');
  });
  it('devolve as linhas sem códigos ANSI', async () => {
    const lines = await renderScreenLines(ESC + '[1mNegrito' + ESC + '[0m\r\ncomum');
    expect(lines).toContain('Negrito');
    expect(lines.join('')).not.toContain('\x1b');
  });
  it('token ausente devolve null', async () => {
    expect(await tokenFromScreen('nada aqui\r\napenas texto')).toBeNull();
  });

  // Regressão 2026-09-28: URL do `claude auth login` (escopo maior que o `setup-token`) passa de 400
  // colunas, quebra em duas linhas de buffer (`isWrapped`), e a versão antiga de `renderScreenLines`
  // devolvia cada pedaço como linha separada — `urlFromScreen` achava só o primeiro pedaço, cortando
  // o `state=...` do fim. Bateu em produção como "Parâmetro state ausente" da Anthropic.
  it('junta uma URL que quebra em mais de uma linha de buffer (>400 colunas) em vez de cortar', async () => {
    const params = 'code=true&client_id=9d1c250a&response_type=code&scope=' +
      'org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins' +
      '&code_challenge=' + 'x'.repeat(80) + '&code_challenge_method=S256&state=' + 'y'.repeat(43);
    const url = `https://claude.com/cai/oauth/authorize?${params}`;
    expect(url.length).toBeGreaterThan(400); // garante que o teste de fato exercita a quebra de linha
    const raw = `If the browser didn't open, visit: ${url}\r\nPaste code here if prompted > `;
    const got = await urlFromScreen(raw);
    expect(got).toBe(url);
    expect(got).toContain('state=' + 'y'.repeat(43));
  });

  it('junta uma URL com hyperlink OSC 8 (target + texto visível) que quebra linha', async () => {
    const params = 'code=true&scope=' + 'org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins' +
      '&state=' + 'z'.repeat(50);
    const url = `https://claude.com/cai/oauth/authorize?${params}`;
    const BEL = '\x07';
    // Formato real do claude auth login: ESC]8;;<url>BEL<url>ESC]8;;BEL (target duplicado como texto visível).
    const raw = `If the browser didn't open, visit: ${ESC}]8;;${url}${BEL}${url}${ESC}]8;;${BEL}\r\nPaste code here if prompted > `;
    const got = await urlFromScreen(raw);
    expect(got).toBe(url);
  });
});
