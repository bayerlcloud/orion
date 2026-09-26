import { Terminal } from '@xterm/headless';

/**
 * Reconstrói a tela final de um fluxo de terminal (ANSI cru com movimentos de cursor)
 * e devolve as linhas de texto, como um terminal de verdade mostraria.
 * É o que torna a captura do token confiável: o `claude setup-token` é um app de tela cheia
 * que reposiciona o cursor, então achatar a saída na mão gruda o token em palavras vizinhas.
 */
export async function renderScreenLines(raw: string, cols = 400, rows = 400): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const s = line.translateToString(true).trim();
      if (s) lines.push(s);
    }
    return lines;
  } finally {
    term.dispose();
  }
}

const TOKEN_RE = /(?<![A-Za-z0-9_-])(sk-ant-oat01-[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])/;
const URL_RE = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/;

export async function tokenFromScreen(raw: string): Promise<string | null> {
  for (const line of await renderScreenLines(raw)) {
    const m = line.match(TOKEN_RE);
    if (m) return m[1];
  }
  return null;
}

export async function urlFromScreen(raw: string): Promise<string | null> {
  for (const line of await renderScreenLines(raw)) {
    const m = line.match(URL_RE);
    if (m) return m[0];
  }
  return null;
}
