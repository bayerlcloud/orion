// Regras puras da Memória: ordenação por importância, rótulos, cores e validação.
// Sem dependência de banco nem de rede — testável isoladamente (tests/memories.test.ts).

export type Status = 'deus' | 'aprendizagem' | 'rascunho';

export const STATUSES: Status[] = ['deus', 'aprendizagem', 'rascunho'];
export const SUMMARY_MAX = 144;
export const MAX_KEYWORDS = 4;

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

/**
 * Posição numérica para ordenar (maior = mais importante). São 7 níveis, do topo para a base:
 * deus (7) · aprendizagem 5 (6) · 4 (5) · 3 (4) · 2 (3) · 1 (2) · rascunho (1).
 */
export function importanceRank(status: string, level?: number | null): number {
  if (status === 'deus') return 7;
  if (status === 'aprendizagem') {
    const l = Number(level);
    const lv = Number.isFinite(l) ? Math.max(1, Math.min(5, Math.round(l))) : 1;
    return lv + 1; // 5 -> 6 ... 1 -> 2
  }
  return 1; // rascunho e qualquer desconhecido
}

/** Rótulo legível: "Deus", "Aprendizagem 4", "Rascunho". */
export function statusLabel(status: string, level?: number | null): string {
  if (status === 'deus') return 'Deus';
  if (status === 'aprendizagem') {
    const l = Number(level);
    const lv = Number.isFinite(l) ? Math.max(1, Math.min(5, Math.round(l))) : 1;
    return `Aprendizagem ${lv}`;
  }
  if (status === 'rascunho') return 'Rascunho';
  return status;
}

/**
 * Nome do token de cor (variável CSS global) para o selo:
 * deus -> accent · aprendizagem alta (>=3) -> info, baixa (<3) -> warn · rascunho -> fg2.
 */
export function statusColor(status: string, level?: number | null): string {
  if (status === 'deus') return 'accent';
  if (status === 'aprendizagem') {
    const l = Number(level);
    const lv = Number.isFinite(l) ? l : 1;
    return lv >= 3 ? 'info' : 'warn';
  }
  return 'fg2'; // rascunho
}

/** Garante string e o limite de 144 caracteres do resumo. */
export function normalizeSummary(v: unknown): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  if (s.length > SUMMARY_MAX) {
    throw new ValidationError(`o resumo passa de ${SUMMARY_MAX} caracteres (${s.length})`);
  }
  return s;
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

/** Status precisa ser um dos três valores válidos. */
export function normalizeStatus(v: unknown): Status {
  if (v === 'deus' || v === 'aprendizagem' || v === 'rascunho') return v;
  throw new ValidationError('status inválido');
}

/** Nível de aprendizagem: 1..5 quando status='aprendizagem', obrigatoriamente null nos outros. */
export function normalizeLearningLevel(status: Status, v: unknown): number | null {
  if (status === 'aprendizagem') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new ValidationError('aprendizagem exige um nível de 1 a 5');
    }
    return n;
  }
  if (v !== null && v !== undefined && v !== '') {
    throw new ValidationError('nível de aprendizagem só vale quando o status é aprendizagem');
  }
  return null;
}

/** id de escopo (projeto/usuário): inteiro positivo ou null (universal). */
export function normalizeScopeId(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('id de escopo inválido');
  return n;
}
