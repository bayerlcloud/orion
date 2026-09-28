import type { ConvEvent, SdkContentBlock, SdkMessage, SessionSummary, ToolStatus } from './types';

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Como a ferramenta aparece na linha de resumo: nome em negrito + descrição secundária. */
export function describeTool(name: string, input: unknown): { label: string; description?: string; inputText?: string } {
  const i = (input ?? {}) as Rec;
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcp) {
    const server = mcp[1].charAt(0).toUpperCase() + mcp[1].slice(1);
    return { label: `${server} [${mcp[2]}]`, inputText: JSON.stringify(input ?? {}, null, 2) };
  }
  switch (name) {
    case 'Bash': return { label: 'Bash', description: str(i.description) ?? str(i.command), inputText: str(i.command) };
    case 'Read': return { label: 'Read', description: str(i.file_path) };
    case 'Write': return { label: 'Write', description: str(i.file_path), inputText: str(i.content) };
    case 'Edit': return { label: 'Edit', description: str(i.file_path), inputText: str(i.new_string) };
    case 'Grep': return { label: 'Grep', description: [str(i.pattern), str(i.path)].filter(Boolean).join(' em ') };
    case 'Glob': return { label: 'Glob', description: str(i.pattern) };
    case 'WebFetch': return { label: 'Web Fetch', description: str(i.url) };
    case 'WebSearch': return { label: 'Web Search', description: str(i.query) };
    case 'Agent': return { label: 'Agent', description: str(i.description) };
    case 'AskUserQuestion': return { label: 'Pergunta', description: 'o Claude quer que você escolha' };
    default: return { label: name, inputText: JSON.stringify(input ?? {}, null, 2) };
  }
}

function resultText(content: SdkContentBlock & { type: 'tool_result' }): string {
  if (typeof content.content === 'string') return content.content;
  return (content.content ?? []).map(b => b.text).join('\n');
}

/** Reduz a lista de mensagens do SDK ao modelo de eventos da tela. Pura e idempotente. */
export function reduceSdkMessages(messages: SdkMessage[]): ConvEvent[] {
  const out: ConvEvent[] = [];
  const toolIndex = new Map<string, number>();
  let sawInit = false;
  let n = 0;
  const nid = () => `e${++n}`;

  for (const m of messages) {
    if (m.type === 'system') {
      if (m.subtype === 'init' && !sawInit) {
        sawInit = true;
        const parts = ['Sessão iniciada'];
        if (m.model) parts.push(`modelo ${m.model}`);
        if (m.cwd) parts.push(`pasta ${m.cwd}`);
        out.push({ id: nid(), kind: 'system', text: parts.join(' · ') });
      }
      continue;
    }
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ id: nid(), kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking.trim()) out.push({ id: nid(), kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') {
          const d = describeTool(b.name, b.input);
          toolIndex.set(b.id, out.length);
          out.push({ id: nid(), kind: 'tool', toolUseId: b.id, name: b.name, label: d.label, description: d.description, input: b.input, inputText: d.inputText, status: 'running' });
        }
      }
      continue;
    }
    if (m.type === 'user') {
      const c = m.message.content;
      const attachments = m.message.attachments;
      if (typeof c === 'string') { if (c.trim() || attachments?.length) out.push({ id: nid(), kind: 'user', text: c, attachments }); continue; }
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) out.push({ id: nid(), kind: 'user', text: b.text, attachments });
        else if (b.type === 'tool_result') {
          const idx = toolIndex.get(b.tool_use_id);
          if (idx === undefined) continue;
          const ev = out[idx];
          if (ev.kind !== 'tool') continue;
          const status: ToolStatus = b.is_error ? 'failure' : 'success';
          out[idx] = { ...ev, output: resultText(b), isError: !!b.is_error, status };
        }
      }
      continue;
    }
    if (m.type === 'result') {
      const tok = sumModelUsage(m.modelUsage) ?? (m.usage ? { input: m.usage.input_tokens ?? 0, output: m.usage.output_tokens ?? 0 } : undefined);
      out.push({ id: nid(), kind: 'result', ok: !m.is_error && m.subtype === 'success', costUsd: m.total_cost_usd, durationMs: m.duration_ms, turns: m.num_turns, inputTokens: tok?.input, outputTokens: tok?.output, error: m.is_error ? (m.result ?? m.subtype) : undefined });
      continue;
    }
    // stream_event: parciais; a tela ao vivo trata separadamente
  }
  return out;
}

/** Estimativa grosseira de tokens: ~4 caracteres por token (como a extensão exibe no thinking). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Soma tokens de entrada/saída de todos os modelos usados no turno (campo modelUsage do result). */
export function sumModelUsage(mu?: Record<string, { inputTokens?: number; outputTokens?: number }>): { input: number; output: number } | undefined {
  if (!mu) return undefined;
  const entries = Object.values(mu);
  if (!entries.length) return undefined;
  let input = 0, output = 0;
  for (const e of entries) { input += e.inputTokens ?? 0; output += e.outputTokens ?? 0; }
  return { input, output };
}

export function formatTokens(n?: number): string {
  if (n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };
/** Diff unificado simples por linhas (LCS). Usado no bloco da ferramenta Edit. */
export function unifiedDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n'), b = newText.split('\n');
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function formatCost(usd?: number): string {
  if (usd === undefined) return '—';
  return `US$ ${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

export type UsageRow = { cost_5h: string | number; cost_7d: string | number; cost_total: string | number };
export type UsageBar = { key: string; label: string; pct: number; sub?: string; resetText?: string };

/** Uma janela de limite real (rate_limits.* do result do SDK): % de uso 0-100 e reset ISO 8601; qualquer um pode vir null. */
export type RealRateLimitWindow = { utilization: number | null; resets_at: string | null } | null | undefined;
/** Entrada de rate_limits.model_scoped[]: mesma janela, mais o rótulo que o servidor manda (ex.: "Fable"). */
export type RealModelScopedWindow = { display_name: string; utilization: number | null; resets_at: string | null };
/**
 * Formato de `rate_limits` do result do SDK (`SDKResultMessage.rate_limits` em
 * `@anthropic-ai/claude-agent-sdk`), só vem preenchido quando `rate_limits_available` é true.
 * Na prática (28/09/2026) nunca vem — ver nota "% real do limite do plano" em PARIDADE.md.
 */
export type RealRateLimits = {
  five_hour?: RealRateLimitWindow;
  seven_day?: RealRateLimitWindow;
  seven_day_sonnet?: RealRateLimitWindow;
  model_scoped?: RealModelScopedWindow[];
} | null | undefined;
/** O que `/api/claude/usage` devolve quando encontrou um result recente com limites reais. */
export type RealUsage = { subscription_type: string | null; rate_limits: RealRateLimits } | null | undefined;

/**
 * Texto "em Xm/Xh/Xd" a partir de um reset ISO 8601 real — espelha a função de formatação de reset
 * da extensão real (`b$5` no webview decompilado v2.1.282: minutos se < 1h, horas se < 24h, senão
 * dias; "em breve" se já passou). Só deve ser chamada com um `resets_at` que a API de fato mandou —
 * nunca para inventar um reset para o proxy por custo.
 */
export function formatResetIn(resetsAtIso: string | null | undefined, now = Date.now()): string | undefined {
  if (!resetsAtIso) return undefined;
  const t = Date.parse(resetsAtIso);
  if (Number.isNaN(t)) return undefined;
  const diffMs = t - now;
  if (diffMs <= 0) return 'em breve';
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'em breve';
  if (min < 60) return `em ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `em ${h}h`;
  return `em ${Math.floor(h / 24)}d`;
}

/**
 * Barras de uso a partir dos limites REAIS da conta, quando `/api/claude/usage` encontrou um result
 * com `rate_limits_available: true`. Espelha a lista exata da extensão real (função `L$5` do webview
 * decompilado v2.1.282): "Sessão (5h)" ← five_hour, "Semanal (7 dias)" ← seven_day, "Semanal Sonnet"
 * ← seven_day_sonnet (só quando o plano é max/team/desconhecido — mesma condição da extensão), e uma
 * barra "Semanal {display_name}" por entrada de `model_scoped` (é daí que vem o rótulo "Fable" da
 * captura de tela). Janelas com `utilization` null são puladas, igual à extensão. Sem % nem reset
 * inventados — só o que a API mandou.
 */
export function computeRealUsageBars(real: RealRateLimits, subscriptionType: string | null | undefined, now = Date.now()): UsageBar[] {
  if (!real) return [];
  const sonnetEligible = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType == null;
  const entries: { key: string; label: string; window: RealRateLimitWindow }[] = [
    { key: '5h', label: 'Sessão (5h)', window: real.five_hour },
    { key: '7d', label: 'Semanal (7 dias)', window: real.seven_day },
    ...(sonnetEligible ? [{ key: '7d-sonnet', label: 'Semanal Sonnet', window: real.seven_day_sonnet }] : []),
    ...(real.model_scoped ?? []).map((m, i) => ({ key: `model-${i}`, label: `Semanal ${m.display_name}`, window: { utilization: m.utilization, resets_at: m.resets_at } as RealRateLimitWindow })),
  ];
  const bars: UsageBar[] = [];
  for (const e of entries) {
    if (!e.window || e.window.utilization === null || e.window.utilization === undefined) continue;
    const pct = Math.round(Math.min(100, Math.max(0, e.window.utilization)));
    bars.push({ key: e.key, label: e.label, pct, resetText: formatResetIn(e.window.resets_at, now) });
  }
  return bars;
}

/**
 * Barras de uso a partir do custo real por janela (proxy), usado quando a API não devolveu limites
 * reais — hoje é sempre o caso (ver `computeUsageBars`/PARIDADE.md). O plano não expõe o % real nesse
 * caso, então usamos o custo contra uma referência.
 */
function computeProxyUsageBars(rows: UsageRow[]): UsageBar[] {
  const sum = (k: keyof UsageRow) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const c5 = sum('cost_5h'), c7 = sum('cost_7d'), ct = sum('cost_total');
  const bar = (key: string, label: string, cost: number, ref: number): UsageBar =>
    ({ key, label, pct: Math.round(Math.min(100, Math.max(0, ref > 0 ? (cost / ref) * 100 : 0))), sub: formatCost(cost) });
  return [
    bar('5h', 'Sessão (5h)', c5, 5),
    bar('7d', 'Semanal (7 dias)', c7, 25),
    bar('total', 'Limite Fable', ct, 100),
  ];
}

/**
 * Barras de uso da barra lateral: usa os limites reais da conta quando `/api/claude/usage` os
 * encontrou (`computeRealUsageBars`); cai para o proxy por custo (`computeProxyUsageBars`) quando
 * não há dado real — que é o caso hoje, com o token de `claude setup-token` (ver PARIDADE.md).
 */
export function computeUsageBars(rows: UsageRow[], real?: RealUsage, now = Date.now()): UsageBar[] {
  const realBars = real ? computeRealUsageBars(real.rate_limits, real.subscription_type, now) : [];
  if (realBars.length) return realBars;
  return computeProxyUsageBars(rows);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const min = Math.round(d / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Filtro combinado da lista de sessões: termo (título ou projeto), projeto exato e só-ativas. Pura. */
export type SessionFilter = { term?: string; project?: string; activeOnly?: boolean };
export function filterSessions(sessions: SessionSummary[], f: SessionFilter): SessionSummary[] {
  const term = (f.term ?? '').trim().toLowerCase();
  return sessions.filter(s => {
    if (f.project && s.project !== f.project) return false;
    if (f.activeOnly && s.status !== 'running' && s.status !== 'waiting') return false;
    if (term) {
      const hit = s.title.toLowerCase().includes(term)
        || (s.project ?? '').toLowerCase().includes(term)
        || (s.projectName ?? '').toLowerCase().includes(term);
      if (!hit) return false;
    }
    return true;
  });
}

/** Como a extensão agrupa a lista lateral: nenhum agrupamento (um grupo só), por projeto, ou por recência. Pura. */
export type GroupBy = 'none' | 'project' | 'recency';
export type SessionGroup = { key: string; label: string; sessions: SessionSummary[] };

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupSessions(sessions: SessionSummary[], groupBy: GroupBy, now = Date.now()): SessionGroup[] {
  if (groupBy === 'project') {
    const byKey = new Map<string, SessionGroup>();
    for (const s of sessions) {
      const key = s.project ?? '__sem_projeto__';
      const label = s.projectName ?? s.project ?? 'Sem projeto';
      if (!byKey.has(key)) byKey.set(key, { key, label, sessions: [] });
      byKey.get(key)!.sessions.push(s);
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }
  if (groupBy === 'recency') {
    const today = startOfDay(now);
    const dayMs = 86_400_000;
    const buckets: Record<'today' | 'yesterday' | 'week' | 'older', SessionSummary[]> = { today: [], yesterday: [], week: [], older: [] };
    for (const s of sessions) {
      const diffDays = Math.round((today - startOfDay(s.updatedAt)) / dayMs);
      if (diffDays <= 0) buckets.today.push(s);
      else if (diffDays === 1) buckets.yesterday.push(s);
      else if (diffDays <= 7) buckets.week.push(s);
      else buckets.older.push(s);
    }
    return ([
      { key: 'today', label: 'Hoje', sessions: buckets.today },
      { key: 'yesterday', label: 'Ontem', sessions: buckets.yesterday },
      { key: 'week', label: 'Esta semana', sessions: buckets.week },
      { key: 'older', label: 'Mais antigas', sessions: buckets.older },
    ] satisfies SessionGroup[]).filter(g => g.sessions.length > 0);
  }
  return [{ key: 'all', label: 'Sem grupo', sessions }];
}
