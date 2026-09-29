// Regras puras da Memória: níveis 0-4, nota do nível 4, rótulos, cores e validação.
// Sem dependência de banco nem de rede — testável isoladamente (tests/memories.test.ts).
// Pirâmide (decisões fechadas 28/09/2026): 0 constituição, 1 mapas automáticos, 2 regras e
// preferências, 3 decisões fechadas, 4 enxame de micro-fatos. Nota (1-10) é EXCLUSIVA do nível 4.

export const LEVELS = [0, 1, 2, 3, 4] as const;
export type Level = (typeof LEVELS)[number];

export const SUMMARY_MAX = 144;
export const MAX_KEYWORDS = 4;
export const NOTA_MIN = 1;
export const NOTA_MAX = 10;
/** Todo micro-fato (nível 4) nasce com esta nota. */
export const NOTA_INICIAL = 5;

/** Erro de validação de entrada: a rota traduz para HTTP 400. */
export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Slug curto em kebab-case a partir de um título (sem acentos, só [a-z0-9-]). */
export function slugify(input: string): string {
  const base = (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // qualquer outra coisa vira hífen
    .replace(/^-+|-+$/g, '') // sem hífen nas pontas
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'memoria';
}

/** Rótulo legível de cada nível: 0 Constituição, 1 Automática, 2 Regra, 3 Decisão, 4 Micro-fato. */
export function nivelLabel(level: number): string {
  switch (Number(level)) {
    case 0: return 'Constituição';
    case 1: return 'Automática';
    case 2: return 'Regra';
    case 3: return 'Decisão';
    case 4: return 'Micro-fato';
    default: return `Nível ${level}`;
  }
}

/**
 * Nome do token de cor (variável CSS global) para o selo, do topo para a base:
 * 0 -> accent · 1 -> info · 2 -> ok · 3 -> warn · 4 -> fg2.
 */
export function nivelColor(level: number): string {
  switch (Number(level)) {
    case 0: return 'accent';
    case 1: return 'info';
    case 2: return 'ok';
    case 3: return 'warn';
    default: return 'fg2';
  }
}

/** Nível precisa ser inteiro de 0 a 4. */
export function normalizeLevel(v: unknown): Level {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 4) throw new ValidationError('nível inválido (use 0 a 4)');
  return n as Level;
}

/**
 * Nota: exclusiva do nível 4 (1 a 10; vazio vira NOTA_INICIAL). Nos outros níveis,
 * obrigatoriamente null.
 */
export function normalizeNota(level: number, v: unknown): number | null {
  if (Number(level) === 4) {
    if (v === null || v === undefined || v === '') return NOTA_INICIAL;
    const n = Number(v);
    if (!Number.isInteger(n) || n < NOTA_MIN || n > NOTA_MAX) {
      throw new ValidationError(`nota do micro-fato vai de ${NOTA_MIN} a ${NOTA_MAX}`);
    }
    return n;
  }
  if (v !== null && v !== undefined && v !== '') {
    throw new ValidationError('nota só existe no nível 4 (micro-fato)');
  }
  return null;
}

/** Garante string e o limite de 144 caracteres do resumo (erro quando passa). */
export function normalizeSummary(v: unknown): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  if (s.length > SUMMARY_MAX) {
    throw new ValidationError(`o resumo passa de ${SUMMARY_MAX} caracteres (${s.length})`);
  }
  return s;
}

/** Versão tolerante do resumo (tool orion-memory): corta em 144 em vez de recusar. */
export function truncateSummary(v: unknown): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : s;
}

/** Lista de palavras-chave: array de strings, no máximo 4, sem vazias nem repetidas. */
export function normalizeKeywords(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ValidationError('palavras-chave inválidas');
  const list = v.map((x) => String(x).trim()).filter(Boolean);
  const uniq = [...new Set(list)];
  if (uniq.length > MAX_KEYWORDS) {
    throw new ValidationError(`no máximo ${MAX_KEYWORDS} palavras-chave`);
  }
  return uniq;
}

/** id de escopo (projeto/usuário): inteiro positivo ou null (universal). */
export function normalizeScopeId(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('id de escopo inválido');
  return n;
}

/** Consulta mínima que uniqueCode precisa (injetada: pool.query da rota, fake nos testes). */
export type CodeQuery = (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }>;

/** Código único na tabela memories: base, base-2, base-3, ... (compartilhado entre rota e tool). */
export async function uniqueCode(query: CodeQuery, base: string, excludeId?: number): Promise<string> {
  const clean = slugify(base);
  let code = clean;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rowCount } = await query(
      'SELECT 1 FROM memories WHERE code = $1 AND ($2::int IS NULL OR id <> $2)',
      [code, excludeId ?? null],
    );
    if (!rowCount) return code;
    n += 1;
    code = `${clean}-${n}`;
  }
}
