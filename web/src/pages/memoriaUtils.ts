// Espelho no cliente das regras puras da Memória (mesma lógica de server/memories/util.ts).

export type Status = 'deus' | 'aprendizagem' | 'rascunho';

export const SUMMARY_MAX = 144;
export const MAX_KEYWORDS = 4;

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

/** Maior = mais importante. deus(7) · aprendizagem 5..1 (6..2) · rascunho(1). */
export function importanceRank(status: string, level?: number | null): number {
  if (status === 'deus') return 7;
  if (status === 'aprendizagem') {
    const l = Number(level);
    const lv = Number.isFinite(l) ? Math.max(1, Math.min(5, Math.round(l))) : 1;
    return lv + 1;
  }
  return 1;
}

/** "Deus", "Aprendizagem 4", "Rascunho". */
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

/** Token de cor (variável CSS global): deus->accent, aprendizagem alta->info / baixa->warn, rascunho->fg2. */
export function statusColor(status: string, level?: number | null): string {
  if (status === 'deus') return 'accent';
  if (status === 'aprendizagem') {
    const l = Number(level);
    const lv = Number.isFinite(l) ? l : 1;
    return lv >= 3 ? 'info' : 'warn';
  }
  return 'fg2';
}

/** var(--token) para usar direto em style. */
export function colorVar(status: string, level?: number | null): string {
  return `var(--${statusColor(status, level)})`;
}

/** Os 7 níveis de importância, do topo para a base, para o seletor do leitor. */
export const IMPORTANCE_OPTIONS: { key: string; status: Status; level: number | null; label: string }[] = [
  { key: 'deus', status: 'deus', level: null, label: 'Deus' },
  { key: 'apr-5', status: 'aprendizagem', level: 5, label: 'Aprendizagem 5' },
  { key: 'apr-4', status: 'aprendizagem', level: 4, label: 'Aprendizagem 4' },
  { key: 'apr-3', status: 'aprendizagem', level: 3, label: 'Aprendizagem 3' },
  { key: 'apr-2', status: 'aprendizagem', level: 2, label: 'Aprendizagem 2' },
  { key: 'apr-1', status: 'aprendizagem', level: 1, label: 'Aprendizagem 1' },
  { key: 'rascunho', status: 'rascunho', level: null, label: 'Rascunho' },
];

/** Chave da opção atual (para o value do <select>). */
export function optionKey(status: string, level?: number | null): string {
  if (status === 'aprendizagem') {
    const l = Number(level);
    const lv = Number.isFinite(l) ? Math.max(1, Math.min(5, Math.round(l))) : 1;
    return `apr-${lv}`;
  }
  if (status === 'deus') return 'deus';
  return 'rascunho';
}

/** Data/hora em pt-BR, "nunca" quando vazio. */
export function fmtDateTime(ts: string | null | undefined, vazio = 'nunca'): string {
  if (!ts) return vazio;
  const d = new Date(ts);
  return Number.isNaN(+d) ? vazio : d.toLocaleString('pt-BR');
}

/** Só a data em pt-BR. */
export function fmtDate(ts: string | null | undefined, vazio = '—'): string {
  if (!ts) return vazio;
  const d = new Date(ts);
  return Number.isNaN(+d) ? vazio : d.toLocaleDateString('pt-BR');
}

/** Corta texto para caber, com reticências. */
export function truncate(text: string, max: number): string {
  const t = text ?? '';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
