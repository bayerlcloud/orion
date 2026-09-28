import { createRequire } from 'node:module';

// @xterm/headless é CommonJS; num projeto ESM o import nomeado quebra em runtime (o lexer não vê o export).
// createRequire pega o module.exports direto, com tipos.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/**
 * Reconstrói a tela final de um fluxo de terminal (ANSI cru com movimentos de cursor)
 * e devolve as linhas de texto, como um terminal de verdade mostraria.
 * É o que torna a captura do token confiável: o `claude setup-token` é um app de tela cheia
 * que reposiciona o cursor, então achatar a saída na mão gruda o token em palavras vizinhas.
 *
 * Linhas mais longas que `cols` quebram em várias linhas de buffer (`line.isWrapped` marca a
 * continuação) — sem juntar essas de volta, uma URL comprida (o `claude auth login` pede um escopo
 * bem maior que o `setup-token`, passa fácil de 400 colunas) fica cortada no meio, perdendo o
 * `state=...` do fim. Bug real, achado em produção em 2026-09-28 (erro "Parâmetro state ausente" da
 * Anthropic) — corrigido juntando as linhas com `isWrapped` na anterior antes de devolver.
 */
export async function renderScreenLines(raw: string, cols = 400, rows = 400): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve));
    const buf = term.buffer.active;
    const logical: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const s = line.translateToString(true);
      if (line.isWrapped && logical.length) logical[logical.length - 1] += s;
      else logical.push(s);
    }
    return logical.map(s => s.trim()).filter(Boolean);
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
