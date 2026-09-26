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
});
