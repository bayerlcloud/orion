// Espelho no cliente das regras puras da Memória (mesma lógica de server/memories/util.ts).
// Pirâmide de níveis 0-4; nota (1-10) é exclusiva do nível 4.

export type Level = 0 | 1 | 2 | 3 | 4;

export const SUMMARY_MAX = 144;
export const MAX_KEYWORDS = 4;
export const NOTA_MIN = 1;
export const NOTA_MAX = 10;
export const NOTA_INICIAL = 5;

/** Slug curto em kebab-case (só [a-z0-9-]). */
export function slugify(input: string): string {
  const base = (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'memoria';
}

/** Rótulo de cada nível: 0 Constituição, 1 Automática, 2 Regra, 3 Decisão, 4 Micro-fato. */
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

/** Token de cor (variável CSS global): 0 accent, 1 info, 2 ok, 3 warn, 4 fg2. */
export function nivelColor(level: number): string {
  switch (Number(level)) {
    case 0: return 'accent';
    case 1: return 'info';
    case 2: return 'ok';
    case 3: return 'warn';
    default: return 'fg2';
  }
}

/** var(--token) para usar direto em style. */
export function colorVar(level: number): string {
  return `var(--${nivelColor(level)})`;
}

/** Escada de escrita: 0 é do Danilo e 1 do script; o painel só edita do 2 para baixo. */
export function nivelEditavel(level: number): boolean {
  return Number(level) >= 2;
}

/** Banner do editor para os níveis somente leitura (null nos editáveis). */
export function nivelBanner(level: number): string | null {
  if (Number(level) === 0) return 'Nível 0 (Constituição): gerido pelo Danilo, direto no CLAUDE.md. Somente leitura aqui.';
  if (Number(level) === 1) return 'Nível 1 (Automática): gerido por script (regenerado a cada ciclo do inventário). Somente leitura aqui.';
  return null;
}

/** Os níveis do seletor do leitor (a escada de escrita trava 0 e 1 fora do editor). */
export const NIVEL_OPTIONS: { level: Level; label: string }[] = [
  { level: 0, label: '0: Constituição' },
  { level: 1, label: '1: Automática' },
  { level: 2, label: '2: Regra' },
  { level: 3, label: '3: Decisão' },
  { level: 4, label: '4: Micro-fato' },
];

/** Data/hora em pt-BR, "nunca" quando vazio. */
export function fmtDateTime(ts: string | null | undefined, vazio = 'nunca'): string {
  if (!ts) return vazio;
  const d = new Date(ts);
  return Number.isNaN(+d) ? vazio : d.toLocaleString('pt-BR');
}

/** Só a data em pt-BR. */
export function fmtDate(ts: string | null | undefined, vazio = '-'): string {
  if (!ts) return vazio;
  const d = new Date(ts);
  return Number.isNaN(+d) ? vazio : d.toLocaleDateString('pt-BR');
}

/** Corta texto para caber, com reticências. */
export function truncate(text: string, max: number): string {
  const t = text ?? '';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
