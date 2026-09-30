/**
 * Detector de SQL destrutivo: usado para exigir confirmação antes de rodar comando que
 * apaga ou altera estrutura/dados do banco (DROP, TRUNCATE, ALTER destrutivo, DELETE/UPDATE
 * sem WHERE). Não é parser de SQL, é heurística por regex sobre a instrução normalizada.
 */

/** Remove comentários e literais de string antes de normalizar, pra não confundir regex com texto dentro deles. */
function limparInstrucao(sql: string): string {
  let s = sql;
  s = s.replace(/--[^\n]*/g, ''); // comentário de linha
  s = s.replace(/\/\*[\s\S]*?\*\//g, ''); // comentário de bloco
  s = s.replace(/\$\$[\s\S]*?\$\$/g, "''"); // corpo de função ($$...$$)
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''"); // literal de string
  return s;
}

/** Divide em instruções por `;`, normaliza espaço e caixa. */
function instrucoes(sql: string): string[] {
  const limpo = limparInstrucao(sql);
  return limpo
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((s) => s.length > 0);
}

const REGRAS: [RegExp, string][] = [
  [/^drop\s+table\b/, 'apaga tabela (DROP TABLE)'],
  [/^truncate\b/, 'apaga todas as linhas (TRUNCATE)'],
  [/^alter\s+table\b.*\bdrop\s+column\b/, 'apaga coluna (ALTER TABLE DROP COLUMN)'],
  [/^alter\s+table\b.*\brename\b/, 'renomeia tabela ou coluna (ALTER TABLE RENAME)'],
  [/^drop\s+schema\b/, 'apaga schema (DROP SCHEMA)'],
  [/^drop\s+function\b/, 'apaga função (DROP FUNCTION)'],
];

/** Devolve o motivo em pt-BR se a instrução for destrutiva, ou null se for comum. */
export function sqlDestrutivo(sql: string): string | null {
  for (const inst of instrucoes(sql)) {
    for (const [re, motivo] of REGRAS) if (re.test(inst)) return motivo;
    if (/^delete\s+from\b/.test(inst) && !/\bwhere\b/.test(inst)) return 'apaga linhas sem WHERE (DELETE)';
    if (/^update\b/.test(inst) && !/\bwhere\b/.test(inst)) return 'altera linhas sem WHERE (UPDATE)';
  }
  return null;
}

/** Primeira tabela citada na primeira instrução destrutiva, ou null se não houver ou não fizer sentido (ex. DROP SCHEMA). */
export function tabelaAlvo(sql: string): string | null {
  for (const inst of instrucoes(sql)) {
    if (!sqlDestrutivo(inst)) continue;
    const m =
      inst.match(/^drop\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)/) ||
      inst.match(/^truncate\s+(?:table\s+)?([a-z0-9_."]+)/) ||
      inst.match(/^alter\s+table\s+([a-z0-9_."]+)/) ||
      inst.match(/^delete\s+from\s+([a-z0-9_."]+)/) ||
      inst.match(/^update\s+([a-z0-9_."]+)/);
    return m ? m[1] : null;
  }
  return null;
}
