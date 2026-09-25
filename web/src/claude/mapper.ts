import type { ConvEvent, SdkContentBlock, SdkMessage, ToolStatus } from './types';

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
  let n = 0;
  const nid = () => `e${++n}`;

  for (const m of messages) {
    if (m.type === 'system') {
      if (m.subtype === 'init') {
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
      if (typeof c === 'string') { if (c.trim()) out.push({ id: nid(), kind: 'user', text: c }); continue; }
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) out.push({ id: nid(), kind: 'user', text: b.text });
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
      out.push({ id: nid(), kind: 'result', ok: !m.is_error && m.subtype === 'success', costUsd: m.total_cost_usd, durationMs: m.duration_ms, turns: m.num_turns, error: m.is_error ? (m.result ?? m.subtype) : undefined });
      continue;
    }
    // stream_event: parciais; a tela ao vivo trata separadamente
  }
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

export function relativeTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const min = Math.round(d / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
