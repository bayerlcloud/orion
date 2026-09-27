// Helpers puros do Dash (formatação pt-BR e sparklines em SVG).

const PT = 'pt-BR';

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString(PT, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${fmtNum(v, digits)}%`;
}

export function fmtBytes(b: number | null | undefined, digits = 1): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(b), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${fmtNum(b < 0 ? -v : v, i === 0 ? 0 : digits)} ${units[i]}`;
}

/** Entrada em KB/s. */
export function fmtKBs(kbs: number | null | undefined): string {
  if (kbs === null || kbs === undefined || !Number.isFinite(kbs)) return '—';
  if (kbs >= 1024 * 1024) return `${fmtNum(kbs / 1024 / 1024, 1)} GB/s`;
  if (kbs >= 1024) return `${fmtNum(kbs / 1024, 1)} MB/s`;
  return `${fmtNum(kbs, kbs < 10 ? 1 : 0)} KB/s`;
}

export function fmtUptime(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

/** "há 5 s", "há 3 min", "há 2 h", "há 4 d". */
export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

export function agoIso(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  return ago(now - t);
}

export type SparkOpts = { max?: number; minMax?: number };

/**
 * Caminhos SVG (linha e área) para uma série. null = lacuna. Escala de 0 até max
 * (ou até o maior valor, nunca abaixo de minMax, para não ampliar ruído).
 */
export function sparkPath(values: (number | null | undefined)[], w: number, h: number, opts: SparkOpts = {}): { line: string; area: string; max: number } {
  const vals = Array.isArray(values) ? values.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)) : [];
  const nums = vals.filter((v): v is number => v !== null);
  const top = opts.max ?? Math.max(opts.minMax ?? 1, ...(nums.length ? nums : [0]));
  const max = top > 0 ? top : 1;
  if (nums.length === 0 || w <= 0 || h <= 0) return { line: '', area: '', max };
  const n = vals.length;
  const x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => h - 1 - Math.min(1, Math.max(0, v / max)) * (h - 2);
  const r = (v: number) => Math.round(v * 100) / 100;
  let line = '', area = '';
  let seg: number[] = [];
  const flush = () => {
    if (seg.length === 0) return;
    const pts = seg.map(i => `${r(x(i))} ${r(y(vals[i] as number))}`);
    line += `M${pts.join('L')}`;
    area += `M${r(x(seg[0]))} ${h}L${pts.join('L')}L${r(x(seg[seg.length - 1]))} ${h}Z`;
    seg = [];
  };
  for (let i = 0; i < n; i++) {
    if (vals[i] === null) flush(); else seg.push(i);
  }
  flush();
  return { line, area, max };
}

export type UserActivity = { id: number; name: string; last_login: string | null; commands_7d: number };

/** Acha a atividade (último login + comandos 7d) de um usuário numa lista vinda de /api/dash/user-activity,
 * por id (preferido) e com um fallback por nome só por segurança -- a lista sempre deve trazer o id. */
export function activityFor(list: UserActivity[] | null | undefined, userId: number | null | undefined, userName?: string | null): UserActivity | null {
  if (!list || list.length === 0) return null;
  if (userId !== null && userId !== undefined) {
    const byId = list.find(a => a.id === userId);
    if (byId) return byId;
  }
  if (userName) return list.find(a => a.name === userName) ?? null;
  return null;
}

/** Estado textual de uma unidade systemd para a tabela. */
export function unitStatus(active: string | undefined, sub: string | undefined): { label: string; failed: boolean; ok: boolean } {
  const a = (active ?? '').toLowerCase(), s = (sub ?? '').toLowerCase();
  if (a === 'failed' || s === 'failed') return { label: 'failed', failed: true, ok: false };
  if (a === 'active') return { label: s && s !== 'running' ? `active (${s})` : 'active', failed: false, ok: true };
  if (!a) return { label: '—', failed: false, ok: false };
  return { label: s ? `${a} (${s})` : a, failed: false, ok: false };
}
