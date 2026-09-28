import { useMemo, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import type { AskQuestion, ConvEvent, UserAttachment } from './types';
import { formatCost, formatDuration, formatTokens, estimateTokens, unifiedDiff, formatAskAnswer, foldExpiredPermissions } from './mapper';
import { Chevron, Copy, Check, Image, File } from './icons';

function Md({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  return <div className="cc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CopyButton({ text, title = 'Copiar' }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  function copy(e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {});
  }
  return <button className="cc-copy" onClick={copy} title={title}>{done ? <Check size={12} /> : <Copy size={12} />}</button>;
}

function Thinking({ e }: { e: Extract<ConvEvent, { kind: 'thinking' }> }) {
  const tokens = estimateTokens(e.text);
  return (
    <details className={`cc-thinking ${e.streaming ? 'is-streaming' : ''}`}>
      <summary>
        <Chevron size={12} className="cc-chev" />
        <span>{e.streaming ? 'Pensando' : 'Pensou'}</span>
        {!e.streaming && tokens > 0 && <span className="cc-thinking-tokens">· {formatTokens(tokens)} tokens</span>}
      </summary>
      <div className="cc-thinking-body">{e.text}</div>
    </details>
  );
}

/** Alvo principal (caminho de arquivo, comando) mostrado em destaque por tipo de ferramenta. */
function toolTarget(e: Extract<ConvEvent, { kind: 'tool' }>): { mono?: string; desc?: string } {
  const i = (e.input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (e.name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return { mono: s(i.file_path), desc: undefined };
    case 'Bash':
      return { mono: s(i.command), desc: s(i.description) };
    default:
      return { desc: e.description };
  }
}

function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = useMemo(() => unifiedDiff(oldText, newText), [oldText, newText]);
  const adds = lines.filter(l => l.type === 'add').length;
  const dels = lines.filter(l => l.type === 'del').length;
  return (
    <div className="cc-diff">
      <div className="cc-diff-stats"><span className="cc-diff-add">+{adds}</span> <span className="cc-diff-del">−{dels}</span></div>
      <pre className="cc-diff-body">{lines.map((l, k) => (
        <div key={k} className={`cc-diff-line is-${l.type}`}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '} {l.text}</div>
      ))}</pre>
    </div>
  );
}

function Tool({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  const { mono, desc } = toolTarget(e);
  const i = (e.input ?? {}) as Record<string, unknown>;
  const isEdit = (e.name === 'Edit') && typeof i.old_string === 'string' && typeof i.new_string === 'string';
  const hasBody = !!(e.inputText || e.output || isEdit);
  const [open, setOpen] = useState(false);
  const copyText = mono ?? e.inputText;
  return (
    <div className={`cc-tool is-${e.status}`}>
      <div className="cc-tool-summary" onClick={() => hasBody && setOpen(o => !o)} style={{ cursor: hasBody ? 'pointer' : 'default' }}>
        {hasBody && <Chevron size={11} className={`cc-chev ${open ? 'is-open' : ''}`} />}
        <span className="cc-tool-name">{e.label}</span>
        {mono && <span className="cc-tool-path cc-mono">{mono}</span>}
        {desc && <span className="cc-tool-desc cc-clamp2">{desc}</span>}
        {copyText && <span className="cc-tool-copy"><CopyButton text={copyText} title="Copiar comando" /></span>}
      </div>
      {hasBody && open && (
        <div className="cc-tool-body">
          {isEdit ? (
            <div className="cc-tool-row"><span className="cc-tool-lbl">DIFF</span><EditDiff oldText={String(i.old_string)} newText={String(i.new_string)} /></div>
          ) : e.inputText ? (
            <div className="cc-tool-row"><span className="cc-tool-lbl">IN</span><pre className="cc-tool-pre">{e.inputText}</pre></div>
          ) : null}
          {e.output !== undefined && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">OUT</span><pre className={`cc-tool-pre ${e.isError ? 'is-error' : ''}`}>{e.output || '(sem saída)'}</pre></div>
          )}
          {e.status === 'running' && e.output === undefined && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">OUT</span><span className="cc-running">executando…</span></div>
          )}
        </div>
      )}
      {hasBody && !open && e.status === 'running' && e.output === undefined && (
        <span className="cc-tool-inline cc-running">executando…</span>
      )}
    </div>
  );
}

/**
 * Formulário de resposta de um AskUserQuestion: uma ou mais perguntas, cada uma com opções de
 * escolha única ou múltipla (`multiSelect`). Só manda a decisão quando o usuário clica "Enviar
 * respostas" (com todas as perguntas respondidas) — clicar numa opção só marca/desmarca, não
 * finaliza mais sozinho (antes, o primeiro clique em qualquer pergunta já respondia tudo, e não
 * dava pra marcar mais de uma opção mesmo em pergunta multiSelect).
 */
function AskAnswer({ questions, onDecide }: { questions: AskQuestion[]; onDecide?: (d: 'answer', msg?: string) => void }) {
  const [picks, setPicks] = useState<Record<number, Set<number>>>({});
  const [freeText, setFreeText] = useState('');

  function toggle(qi: number, oi: number, multi: boolean) {
    setPicks(prev => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) { if (cur.has(oi)) cur.delete(oi); else cur.add(oi); }
      else { cur.clear(); cur.add(oi); }
      return { ...prev, [qi]: cur };
    });
  }
  function submit() {
    const picksArr = questions.map((q, qi) => [...(picks[qi] ?? [])].sort((a, b) => a - b).map(oi => q.options[oi].label));
    onDecide?.('answer', formatAskAnswer(questions, picksArr));
  }
  const ready = questions.every((_, qi) => (picks[qi]?.size ?? 0) > 0);

  return (
    <div className="cc-perm cc-ask">
      {questions.map((q, qi) => (
        <div key={qi} className="cc-ask-q">
          {q.header && <div className="cc-ask-header">{q.header}</div>}
          <div className="cc-ask-title">{q.question}{q.multiSelect && <span className="cc-ask-multi"> · escolha uma ou mais</span>}</div>
          <div className="cc-ask-opts">
            {q.options.map((o, oi) => {
              const selected = picks[qi]?.has(oi) ?? false;
              return (
                <button key={oi} type="button" className={`cc-btn cc-ask-opt ${selected ? 'is-selected' : ''}`}
                  onClick={() => toggle(qi, oi, !!q.multiSelect)} title={o.description} aria-pressed={selected}>
                  <span className="cc-ask-opt-label">{o.label}</span>
                  {o.description && <span className="cc-ask-opt-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="cc-ask-submit-row">
        <button className="cc-btn cc-btn-primary" disabled={!ready} onClick={submit}>Enviar respostas</button>
      </div>
      <input className="cc-perm-reject" placeholder="ou escreva sua própria resposta…" value={freeText} onChange={ev => setFreeText(ev.target.value)}
        onKeyDown={ev => { if (ev.key === 'Enter' && freeText.trim()) onDecide?.('answer', freeText.trim()); }} />
      <div className="cc-hints">Escolha as opções e clique em Enviar respostas · ou escreva a sua e Enter</div>
    </div>
  );
}

function Permission({ e, onDecide }: { e: Extract<ConvEvent, { kind: 'permission' }>; onDecide?: (d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) => void }) {
  const isAsk = !!(e.questions && e.questions.length);
  if (e.decision) {
    if (e.decision === 'answer') return <div className="cc-perm-done">Você respondeu: <b>{e.answer ?? e.inputText}</b></div>;
    if (e.decision === 'timeout') {
      const n = e.expiredGroupCount ?? 1;
      const txt = n > 1
        ? `${n} pedidos de permissão expiraram (o painel reiniciou enquanto esperavam resposta) · peça de novo`
        : `${isAsk ? 'Pergunta expirada (sessão reiniciou)' : 'Pedido expirado'} · peça de novo`;
      return <div className="cc-perm-done cc-perm-exp">{txt}</div>;
    }
    const txt = e.decision === 'deny' ? 'Negado' : e.decision === 'allow_always' ? 'Permitido, sem perguntar de novo' : 'Permitido';
    return <div className="cc-perm-done">{txt}{!isAsk && <> · <span className="cc-mono">{e.inputText}</span></>}</div>;
  }
  if (isAsk) return <AskAnswer questions={e.questions!} onDecide={onDecide} />;
  return (
    <div className="cc-perm">
      <div className="cc-perm-head">Aguardando sua permissão</div>
      <div className="cc-perm-sub"><b>{e.label}</b> <span className="cc-tool-desc">{e.description}</span></div>
      <pre className="cc-tool-pre cc-perm-input">{e.inputText}</pre>
      <div className="cc-perm-actions">
        <button className="cc-btn cc-btn-primary" onClick={() => onDecide?.('allow')}>Sim</button>
        <button className="cc-btn" onClick={() => onDecide?.('allow_always')}>Sim, e não perguntar de novo</button>
        <button className="cc-btn" onClick={() => onDecide?.('deny')}>Não</button>
      </div>
      <input className="cc-perm-reject" placeholder="Não, e diga ao Claude o que fazer em vez disso…" onKeyDown={ev => { if (ev.key === 'Enter') onDecide?.('deny', (ev.target as HTMLInputElement).value); }} />
      <div className="cc-hints">Enter envia · Esc cancela</div>
    </div>
  );
}

/** Anexos de uma mensagem do usuário: chips com nome (imagem ou arquivo). Só metadados; sem miniatura no histórico. */
function Attachments({ items }: { items: UserAttachment[] }) {
  return (
    <div className="cc-user-attach">
      {items.map((a, i) => (
        <span key={i} className={`cc-attach is-chip ${a.kind === 'image' ? 'is-image' : ''}`} title={a.name}>
          <span className="cc-attach-ico">{a.kind === 'image' ? <Image size={13} /> : <File size={13} />}</span>
          <span className="cc-attach-name">{a.name}</span>
        </span>
      ))}
    </div>
  );
}

function Result({ e }: { e: Extract<ConvEvent, { kind: 'result' }> }) {
  if (!e.ok) return <div className="cc-result is-error">Encerrou com erro: {e.error}</div>;
  const tokens = (e.inputTokens !== undefined || e.outputTokens !== undefined)
    ? ` · ${formatTokens(e.inputTokens)}↑ / ${formatTokens(e.outputTokens)}↓ tokens` : '';
  return <div className="cc-result">Concluído · {formatCost(e.costUsd)} · {formatDuration(e.durationMs)} · {e.turns ?? '—'} turnos{tokens}</div>;
}

function dotClass(e: ConvEvent): string {
  switch (e.kind) {
    case 'tool': return e.status === 'success' ? 'dot-success' : e.status === 'failure' ? 'dot-failure' : e.status === 'warning' ? 'dot-warning' : 'dot-progress';
    case 'permission': return e.decision === 'timeout' ? 'dot-warning' : e.decision ? 'dot-success' : 'dot-pending';
    case 'result': return e.ok ? 'dot-success' : 'dot-failure';
    case 'thinking': return e.streaming ? 'dot-progress' : '';
    default: return '';
  }
}

export default function Timeline({ events, onDecide }: { events: ConvEvent[]; onDecide?: (id: string, d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) => void }) {
  // Colapsa fileiras de "expirado" consecutivas (deploy com restarts seguidos órfa vários pedidos
  // de permissão de uma vez — ver foldExpiredPermissions) num único bubble com contagem.
  const folded = useMemo(() => foldExpiredPermissions(events), [events]);
  return (
    <div className="cc-timeline">
      {folded.map(e => {
        if (e.kind === 'system' || e.kind === 'result') return null;
        if (e.kind === 'user') return (
          <div key={e.id} className="cc-user">
            {e.text && <div className="cc-user-text">{e.text}</div>}
            {e.attachments && e.attachments.length > 0 && <Attachments items={e.attachments} />}
          </div>
        );
        return (
          <div key={e.id} className={`cc-msg ${dotClass(e)}`}>
            {e.kind === 'text' && <Md text={e.text} />}
            {e.kind === 'thinking' && <Thinking e={e} />}
            {e.kind === 'tool' && <Tool e={e} />}
            {e.kind === 'permission' && <Permission e={e} onDecide={(d, msg) => onDecide?.(e.id, d, msg)} />}
          </div>
        );
      })}
    </div>
  );
}
