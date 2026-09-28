import { useMemo, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import type { AskQuestion, ConvEvent, UserAttachment } from './types';
import { formatCost, formatDuration, formatTokens, estimateTokens, unifiedDiff, annotateCharDiffs, parseTodos, taskStatusLabel, formatAskAnswer, foldExpiredPermissions } from './mapper';
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

/**
 * Mensagem de texto do assistente — Markdown + botão de copiar revelado no hover (mesmo padrão de
 * `cc-tool-copy`/`CopyButton` já usado nos blocos de ferramenta; espelha `copyResponseButton_07S1Yg`/
 * `assistantActions_07S1Yg` da extensão real, que mostra "Copy response" ao lado da mensagem só depois
 * dela terminar — por isso `!e.streaming` aqui também). Quando o texto é o resto de um turno
 * interrompido (botão Parar — ver `live.ts`/`interruptedLabel`), mostra o selo logo abaixo, num
 * estilo neutro/aviso (`cc-interrupted`), nunca vermelho — não é um erro, é só um turno cortado.
 */
function AssistantText({ e }: { e: Extract<ConvEvent, { kind: 'text' }> }) {
  return (
    <>
      <div className="cc-text-row">
        <Md text={e.text} />
        {!e.streaming && e.text && <span className="cc-text-copy"><CopyButton text={e.text} title="Copiar resposta" /></span>}
      </div>
      {e.interrupted && <div className="cc-interrupted">{e.interrupted}</div>}
    </>
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

/**
 * Corpo de uma linha do diff: se a linha ganhou destaque de caractere (par del/add reconhecido como
 * "a mesma linha, editada" — ver `annotateCharDiffs`/`charDiffIfSimilar`), renderiza os trechos
 * ctx/add/del com `<span>` próprio; senão, o texto puro (linha só adicionada/removida, ou trocas
 * demais pra valer a pena destacar caractere a caractere).
 */
function DiffLineBody({ text, parts }: { text: string; parts?: { type: 'ctx' | 'add' | 'del'; text: string }[] }) {
  if (!parts) return <>{text}</>;
  return <>{parts.map((p, k) => p.type === 'ctx' ? <span key={k}>{p.text}</span> : <span key={k} className={`cc-diff-char is-${p.type}`}>{p.text}</span>)}</>;
}

function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = useMemo(() => annotateCharDiffs(unifiedDiff(oldText, newText)), [oldText, newText]);
  const adds = lines.filter(l => l.type === 'add').length;
  const dels = lines.filter(l => l.type === 'del').length;
  return (
    <div className="cc-diff">
      <div className="cc-diff-stats"><span className="cc-diff-add">+{adds}</span> <span className="cc-diff-del">−{dels}</span></div>
      <pre className="cc-diff-body">{lines.map((l, k) => (
        <div key={k} className={`cc-diff-line is-${l.type}`}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '} <DiffLineBody text={l.text} parts={l.parts} /></div>
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
 * Checklist do TodoWrite — igual à extensão real (`gG0`/`J65`/classes `todoListContainer_xheXVQ`,
 * `todoList_xheXVQ`, `todoItem_xheXVQ`, `completed_xheXVQ`, `content_xheXVQ` em webview/index.js
 * v2.1.282): um checkbox por item (marcado = completed, indeterminado/meio-marcado = in_progress,
 * vazio = pending — a extensão usa um `<input type=checkbox disabled>` com `.indeterminate` pro
 * estado "em andamento"; aqui é um ícone equivalente, já que não temos elemento de formulário aqui)
 * e o texto do item riscado + esmaecido quando completed (`text-decoration:line-through` no CSS
 * real). Cabeçalho real é sempre o texto fixo "Update Todos" — mostramos "Lista de tarefas" (PT-BR).
 */
function TodoList({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  const todos = useMemo(() => parseTodos(e.input), [e.input]);
  if (!todos.length) return null;
  return (
    <div className="cc-todo">
      <div className="cc-todo-head"><span className="cc-tool-name">Lista de tarefas</span></div>
      <ul className="cc-todo-list">
        {todos.map((t, k) => (
          <li key={k} className={`cc-todo-item is-${t.status}`}>
            <span className={`cc-todo-check is-${t.status}`} aria-hidden="true" />
            <span className="cc-todo-content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Linha de subagente (tool `Task`) — a extensão real chama esse tool internamente de "Agent"
 * (`$==="Task"?"Agent":$` em webview/index.js v2.1.282) e mostra "Agent: {description}" no
 * cabeçalho, com o prompt como corpo IN e sem OUT (`class jD1{name="Agent";renderOutput(){return null}}`).
 * Linha própria (não passa pelo bloco de ferramenta genérico): descrição em destaque, tipo do
 * subagente (`subagent_type`) como selo secundário quando existe, e status rodando/concluído/falhou
 * (`taskStatusLabel`) — a extensão tem telemetria ao vivo (tempo decorrido, tokens, contagem de tool
 * calls do subagente) que exigiria um stream de progresso por tarefa que o Orion não tem hoje; aqui
 * mostramos o `ToolStatus` que já temos. Mantemos IN (prompt) e OUT (resultado final do subagente,
 * que a extensão esconde mas que aqui é informação útil) dobráveis, como os outros tool blocks.
 */
function TaskAgent({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  const i = (e.input ?? {}) as Record<string, unknown>;
  const description = typeof i.description === 'string' ? i.description : e.label;
  const prompt = typeof i.prompt === 'string' ? i.prompt : e.inputText;
  const subagentType = typeof i.subagent_type === 'string' ? i.subagent_type : undefined;
  const hasBody = !!(prompt || e.output);
  const [open, setOpen] = useState(false);
  return (
    <div className={`cc-tool cc-task is-${e.status}`}>
      <div className="cc-tool-summary" onClick={() => hasBody && setOpen(o => !o)} style={{ cursor: hasBody ? 'pointer' : 'default' }}>
        {hasBody && <Chevron size={11} className={`cc-chev ${open ? 'is-open' : ''}`} />}
        <span className="cc-tool-name">Agent</span>
        {description && <span className="cc-tool-desc cc-clamp2">{description}</span>}
        {subagentType && <span className="cc-task-type">{subagentType}</span>}
        <span className={`cc-task-status is-${e.status}`}>{taskStatusLabel(e.status)}</span>
        {prompt && <span className="cc-tool-copy"><CopyButton text={prompt} title="Copiar prompt" /></span>}
      </div>
      {hasBody && open && (
        <div className="cc-tool-body">
          {prompt && <div className="cc-tool-row"><span className="cc-tool-lbl">IN</span><pre className="cc-tool-pre">{prompt}</pre></div>}
          {e.output !== undefined && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">OUT</span><pre className={`cc-tool-pre ${e.isError ? 'is-error' : ''}`}>{e.output || '(sem saída)'}</pre></div>
          )}
          {e.status === 'running' && e.output === undefined && (
            <div className="cc-tool-row"><span className="cc-tool-lbl">OUT</span><span className="cc-running">executando…</span></div>
          )}
        </div>
      )}
    </div>
  );
}

/** Escolhe a renderização de um evento `tool`: checklist dedicada pro TodoWrite, linha de subagente
 * dedicada pro Task, bloco de ferramenta genérico pros demais. */
function ToolBlock({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  if (e.name === 'TodoWrite') return <TodoList e={e} />;
  if (e.name === 'Task') return <TaskAgent e={e} />;
  return <Tool e={e} />;
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
            {e.kind === 'text' && <AssistantText e={e} />}
            {e.kind === 'thinking' && <Thinking e={e} />}
            {e.kind === 'tool' && <ToolBlock e={e} />}
            {e.kind === 'permission' && <Permission e={e} onDecide={(d, msg) => onDecide?.(e.id, d, msg)} />}
          </div>
        );
      })}
    </div>
  );
}
