import { useMemo } from 'react';
import { marked } from 'marked';
import type { ConvEvent } from './types';
import { formatCost, formatDuration } from './mapper';
import { Chevron } from './icons';

function Md({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  return <div className="cc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Thinking({ e }: { e: Extract<ConvEvent, { kind: 'thinking' }> }) {
  return (
    <details className={`cc-thinking ${e.streaming ? 'is-streaming' : ''}`}>
      <summary><Chevron size={12} className="cc-chev" /><span>{e.streaming ? 'Pensando' : 'Pensou'}</span></summary>
      <div className="cc-thinking-body">{e.text}</div>
    </details>
  );
}

function Tool({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  const showBody = !!(e.inputText || e.output);
  return (
    <div className={`cc-tool is-${e.status}`}>
      <div className="cc-tool-summary">
        <span className="cc-tool-name">{e.label}</span>
        {e.description && <span className="cc-tool-desc">{e.description}</span>}
      </div>
      {showBody && (
        <div className="cc-tool-body">
          {e.inputText && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">IN</span><pre className="cc-tool-pre">{e.inputText}</pre></div>
          )}
          {e.output !== undefined && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">OUT</span><pre className={`cc-tool-pre ${e.isError ? 'is-error' : ''}`}>{e.output || '(sem saída)'}</pre></div>
          )}
          {e.status === 'running' && !e.output && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">OUT</span><span className="cc-running">executando…</span></div>
          )}
        </div>
      )}
    </div>
  );
}

function Permission({ e, onDecide }: { e: Extract<ConvEvent, { kind: 'permission' }>; onDecide?: (d: 'allow' | 'allow_always' | 'deny', msg?: string) => void }) {
  if (e.decision) {
    const txt = e.decision === 'deny' ? 'Negado' : e.decision === 'allow_always' ? 'Permitido, sem perguntar de novo' : 'Permitido';
    return <div className="cc-perm-done">{txt} · <span className="cc-mono">{e.inputText}</span></div>;
  }
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

function Result({ e }: { e: Extract<ConvEvent, { kind: 'result' }> }) {
  if (!e.ok) return <div className="cc-result is-error">Encerrou com erro: {e.error}</div>;
  return <div className="cc-result">Concluído · {formatCost(e.costUsd)} · {formatDuration(e.durationMs)} · {e.turns ?? '—'} turnos</div>;
}

function dotClass(e: ConvEvent): string {
  switch (e.kind) {
    case 'tool': return e.status === 'success' ? 'dot-success' : e.status === 'failure' ? 'dot-failure' : e.status === 'warning' ? 'dot-warning' : 'dot-progress';
    case 'permission': return e.decision ? 'dot-success' : 'dot-pending';
    case 'result': return e.ok ? 'dot-success' : 'dot-failure';
    case 'thinking': return e.streaming ? 'dot-progress' : '';
    default: return '';
  }
}

export default function Timeline({ events, onDecide }: { events: ConvEvent[]; onDecide?: (id: string, d: 'allow' | 'allow_always' | 'deny', msg?: string) => void }) {
  return (
    <div className="cc-timeline">
      {events.map(e => {
        if (e.kind === 'user') return <div key={e.id} className="cc-user">{e.text}</div>;
        return (
          <div key={e.id} className={`cc-msg ${dotClass(e)}`}>
            {e.kind === 'text' && <Md text={e.text} />}
            {e.kind === 'thinking' && <Thinking e={e} />}
            {e.kind === 'tool' && <Tool e={e} />}
            {e.kind === 'permission' && <Permission e={e} onDecide={(d, msg) => onDecide?.(e.id, d, msg)} />}
            {e.kind === 'result' && <Result e={e} />}
            {e.kind === 'system' && <div className="cc-system">{e.text}</div>}
          </div>
        );
      })}
    </div>
  );
}
