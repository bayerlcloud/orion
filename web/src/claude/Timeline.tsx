import React, { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import type { AgentTask, AskQuestion, ConvEvent, UserAttachment } from './types';
import { formatDuration, formatTokens, estimateTokens, thinkingLabel, unifiedDiff, annotateCharDiffs, parseTodos, taskStatusLabel, formatAskAnswer, foldExpiredPermissions, spinnerGlyphAt, spinnerWordDelayMs, pickSpinnerWord, SPINNER_GLYPH_INTERVAL_MS, attachmentImageUrl, splitAgentRows, agentRowLabel, agentRowMeta, agentOverflowLabel, agentOverflowMeta } from './mapper';
import { Chevron, Copy, Check, Image, File } from './icons';
import { InnerCallList } from './AgentMap';
import Lightbox, { type LightboxImage } from './Lightbox';
import Ouvir from './Ouvir';
import { api } from '../api';

/**
 * Markdown do assistente — espelho do `root_-a7MRw` real: `p` em pre-wrap com margens .1em/.2em,
 * bloco de código sem borda (raio 4, padding 8) embrulhado num `codeBlockWrapper` com botão de copiar
 * no canto (aparece no hover). O botão é um `<button data-copy>` gerado pelo renderer do marked e
 * tratado por delegação de clique aqui (um handler pro container inteiro).
 */
const mdRenderer = new marked.Renderer();
const baseCode = mdRenderer.code.bind(mdRenderer);
mdRenderer.code = function (token: Parameters<typeof baseCode>[0]) {
  const inner = baseCode(token);
  return `<div class="cc-codeblock"><button class="cc-copy cc-code-copy" data-copy title="Copiar" aria-label="Copiar">${COPY_SVG}</button>${inner}</div>`;
};
const COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
function Md({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { renderer: mdRenderer }) as string, [text]);
  const onClick = useCallback((ev: MouseEvent) => {
    const btn = (ev.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
    if (!btn) return;
    ev.stopPropagation();
    const pre = btn.parentElement?.querySelector('pre');
    navigator.clipboard?.writeText(pre?.textContent ?? '').catch(() => {});
  }, []);
  return <div className="cc-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function CopyButton({ text, title = 'Copiar', className = '' }: { text: string; title?: string; className?: string }) {
  const [done, setDone] = useState(false);
  function copy(e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {});
  }
  return <button className={`cc-copy ${className}`} onClick={copy} title={title} aria-label={title}>{done ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function Thinking({ e }: { e: Extract<ConvEvent, { kind: 'thinking' }> }) {
  const tokens = estimateTokens(e.text);
  if (!e.text.trim()) return null;
  return (
    <details className={`cc-thinking ${e.streaming ? 'is-streaming' : ''}`}>
      <summary>
        <span>{thinkingLabel(!!e.streaming, e.durationMs)}</span>
        {tokens > 0 && <span className="cc-thinking-tokens"> · {formatTokens(tokens)} tokens</span>}
        <Chevron size={10} className="cc-chev" />
      </summary>
      <div className="cc-thinking-body">{e.text}</div>
    </details>
  );
}

/**
 * Mensagem de texto do assistente — `message_07S1Yg` real: Markdown e, terminada a mensagem, uma
 * linha própria de 16px (`assistantActions`) com o botão "Copiar resposta" de 20px revelado no hover.
 */
function AssistantText({ e }: { e: Extract<ConvEvent, { kind: 'text' }> }) {
  return (
    <>
      {!e.streaming && e.text && <Ouvir id={e.id} text={e.text} />}
      <Md text={e.text} />
      {!e.streaming && e.text && <div className="cc-actions"><CopyButton text={e.text} title="Copiar resposta" className="cc-copy-response" /></div>}
      {e.interrupted && <div className="cc-interrupted">{e.interrupted}</div>}
    </>
  );
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

/** Texto longo o bastante pra ser cortado em 60px (`ew` real: >250 caracteres ou >3 linhas). */
function isLong(s: string): boolean { return s.length > 250 || s.split('\n').length > 3; }
const base = (p?: string) => (p ?? '').split('/').pop() || p || '';

/**
 * Conteúdo de uma linha IN/OUT do bloco de ferramenta — `toolBodyRowContent_ZUQaOA` real: sempre
 * visível, cortado em 60px com esmaecimento (`mask-image` 50→60px) quando é longo. A extensão abre o
 * texto inteiro numa aba do editor ao clicar; aqui, sem editor, o clique tira o corte (e devolve).
 */
function RowContent({ text, children, error }: { text: string; children?: React.ReactNode; error?: boolean }) {
  const long = isLong(text);
  const [open, setOpen] = useState(false);
  const clip = long && !open;
  return (
    <div className={`cc-tool-content ${clip ? 'is-clipped' : ''} ${error ? 'is-error' : ''}`} role={long ? 'button' : undefined} tabIndex={long ? 0 : undefined}
      title={long ? (open ? 'Clique para recolher' : 'Clique para ver o texto inteiro') : undefined}
      onClick={long ? () => setOpen(o => !o) : undefined}
      onKeyDown={long ? ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(o => !o); } } : undefined}>
      {children ?? <pre>{text}</pre>}
    </div>
  );
}
function Row({ label, text, error, copy, children }: { label: string; text: string; error?: boolean; copy?: boolean; children?: React.ReactNode }) {
  return (
    <div className="cc-tool-row">
      <div className="cc-tool-lbl">{label}</div>
      <RowContent text={text} error={error}>{children}</RowContent>
      {copy && <CopyButton text={text} title="Copiar" className="cc-row-copy" />}
    </div>
  );
}
/** Linha secundária abaixo do cabeçalho (`secondaryLine_mLrg7g` real): contagens, "Write failed", motivo de rejeição. */
function Secondary({ children }: { children: React.ReactNode }) { return <div className="cc-tool-secondary"><span>{children}</span></div>; }

function editSummary(oldText: string, newText: string): string {
  const a = oldText.split('\n').length, b = newText.split('\n').length;
  const add = Math.max(0, b - a), del = Math.max(0, a - b);
  const s = (n: number) => (n === 1 ? '' : 's');
  if (add && del) return `${add} linha${s(add)} adicionada${s(add)}, ${del} removida${s(del)}`;
  if (add) return `${add} linha${s(add)} adicionada${s(add)}`;
  if (del) return `${del} linha${s(del)} removida${s(del)}`;
  return 'Modificado';
}
function countLines(out?: string): number { return out ? out.trim().split('\n').filter(l => l.length).length : 0; }

/**
 * Bloco de ferramenta — mesma composição da extensão real (`root_ZUQaOA`): cabeçalho por ferramenta
 * (nome em negrito + alvo em mono na cor de link, ou descrição em texto secundário) e corpo SEM
 * chevron e SEM colapso: IN/OUT sempre à vista, cortados em 60px. Read/Glob/Grep não têm corpo; Bash
 * mostra a descrição no cabeçalho e o comando na linha IN (com copiar no canto); Edit/Write mostram a
 * linha de contagem e o corpo sem rótulos. Sem indicador textual de "executando": é a bolinha da
 * linha do tempo que pisca (`dotProgress`), igual à real.
 */
function Tool({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  const i = (e.input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const hasOut = e.output !== undefined;
  const outText = e.output || '(sem saída)';
  let header: React.ReactNode;
  let body: React.ReactNode = null;
  switch (e.name) {
    case 'Bash': case 'PowerShell': {
      header = <><span className="cc-tool-name">{e.name} </span>{s(i.description) && <span className="cc-tool-plain">{s(i.description)}</span>}</>;
      body = (
        <div className="cc-tool-body"><div className="cc-tool-grid">
          <Row label="IN" text={s(i.command) ?? ''} copy />
          {hasOut && <Row label="OUT" text={outText} error={e.isError} />}
        </div></div>
      );
      break;
    }
    case 'Read': {
      const off = typeof i.offset === 'number' ? i.offset : undefined, lim = typeof i.limit === 'number' ? i.limit : undefined;
      const range = off !== undefined && lim !== undefined ? ` (linhas ${off + 1}-${off + lim})` : off !== undefined ? ` (a partir da linha ${off + 1})` : '';
      header = <><span className="cc-tool-name">Read </span>{s(i.file_path) && <span className="cc-tool-path" title={s(i.file_path)}>{base(s(i.file_path))}</span>}{range && <span>{range}</span>}</>;
      break;
    }
    case 'Edit': case 'MultiEdit': {
      const oldS = s(i.old_string) ?? '', newS = s(i.new_string) ?? '';
      header = <><span className="cc-tool-name">Edit </span><span className="cc-tool-path" title={s(i.file_path)}>{base(s(i.file_path))}</span></>;
      body = (
        <>
          <Secondary>{e.isError ? 'Edição falhou' : editSummary(oldS, newS)}</Secondary>
          <div className="cc-tool-body cc-tool-body-wrap"><EditDiff oldText={oldS} newText={newS} /></div>
        </>
      );
      break;
    }
    case 'Write': {
      const content = s(i.content) ?? '';
      const n = content.split('\n').length;
      header = <><span className="cc-tool-name">Write </span><span className="cc-tool-path" title={s(i.file_path)}>{base(s(i.file_path))}</span></>;
      body = (
        <>
          <Secondary>{e.isError ? 'Escrita falhou' : `${n} linha${n === 1 ? '' : 's'}`}</Secondary>
          <div className="cc-tool-body cc-tool-body-wrap"><RowContent text={content} /></div>
        </>
      );
      break;
    }
    case 'Glob': {
      header = <><span className="cc-tool-name">Glob</span> <span className="cc-tool-path">pattern: "{s(i.pattern)}"</span></>;
      if (hasOut) { const n = e.output?.trim() === 'No files found' ? 0 : countLines(e.output); body = <Secondary>{n === 0 ? 'Nenhum arquivo encontrado' : n === 1 ? '1 arquivo encontrado' : `${n} arquivos encontrados`}</Secondary>; }
      break;
    }
    case 'Grep': {
      const extra = [s(i.path) && `em ${s(i.path)}`, s(i.glob) && `glob: ${s(i.glob)}`, s(i.type) && `type: ${s(i.type)}`].filter(Boolean).join(', ');
      header = <><span className="cc-tool-name">Grep</span> <span className="cc-tool-path">"{s(i.pattern)}"{extra && ` (${extra})`}</span></>;
      if (hasOut) { const n = countLines(e.output); body = <Secondary>{n === 0 ? 'Nenhuma ocorrência' : n === 1 ? '1 ocorrência' : `${n} ocorrências`}</Secondary>; }
      break;
    }
    case 'WebFetch': {
      header = <><span className="cc-tool-name">Web Fetch</span><span className="cc-tool-path">{s(i.url)}</span></>;
      if (hasOut) body = e.isError ? <div className="cc-tool-body"><div className="cc-tool-grid"><Row label="OUT" text={outText} error /></div></div> : <div className="cc-tool-body"><div className="cc-tool-plaintext">Baixado de {s(i.url)}</div></div>;
      break;
    }
    case 'WebSearch': {
      header = <><span className="cc-tool-name">Web Search</span><span className="cc-tool-path">{s(i.query)}</span></>;
      if (hasOut) body = <div className="cc-tool-body"><div className="cc-tool-grid"><Row label="OUT" text={outText} error={e.isError} /></div></div>;
      break;
    }
    case 'Skill': {
      header = <><span className="cc-tool-name">{(s(i.skill) ?? '').replace(/^\//, '')}</span><span className="cc-tool-path"> skill</span></>;
      break;
    }
    default: {
      header = <span className="cc-tool-name">{e.label}</span>;
      const inText = e.inputText ?? '';
      if (inText || hasOut) body = (
        <div className="cc-tool-body"><div className="cc-tool-grid">
          {inText && <Row label="IN" text={inText} />}
          {hasOut && <Row label="OUT" text={outText} error={e.isError} />}
        </div></div>
      );
    }
  }
  return (
    <div className={`cc-tool is-${e.status}`}>
      <div className="cc-tool-summary">{header}</div>
      {body}
    </div>
  );
}

function TodoList({ e }: { e: Extract<ConvEvent, { kind: 'tool' }> }) {
  const todos = useMemo(() => parseTodos(e.input), [e.input]);
  if (!todos.length) return null;
  return (
    <div className="cc-tool">
      <div className="cc-tool-summary"><span className="cc-tool-name">Lista de tarefas</span></div>
      <div className="cc-todo">
        <ul className="cc-todo-list">
          {todos.map((t, k) => (
            <li key={k} className={`cc-todo-item ${t.status === 'completed' ? 'is-completed' : ''}`}>
              <span className={`cc-todo-check is-${t.status}`} aria-hidden="true" />
              <div className="cc-todo-content">{t.content}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TaskAgent({ e, task }: { e: Extract<ConvEvent, { kind: 'tool' }>; task?: AgentTask }) {
  const i = (e.input ?? {}) as Record<string, unknown>;
  const description = typeof i.description === 'string' ? i.description : e.label;
  const prompt = typeof i.prompt === 'string' ? i.prompt : e.inputText;
  const calls = task?.toolCalls ?? [];
  return (
    <div className={`cc-tool cc-task is-${e.status}`}>
      <div className="cc-tool-summary"><span className="cc-tool-name">Agent:</span><span className="cc-tool-path">{description}</span></div>
      {(prompt || calls.length > 0) && (
        <div className="cc-tool-body"><div className="cc-tool-grid">
          {calls.length > 0 && <div className="cc-tool-row"><div className="cc-tool-lbl">TOOLS</div><div className="cc-tool-content"><InnerCallList calls={calls} /></div></div>}
          {prompt && <Row label="IN" text={prompt} />}
        </div></div>
      )}
    </div>
  );
}

/** Escolhe a renderização de um evento `tool`: checklist dedicada pro TodoWrite, linha de subagente
 * dedicada pro Task (com as tool calls aninhadas dele, quando `agentTasks` chegou), bloco de
 * ferramenta genérico pros demais. */
function ToolBlock({ e, agentTasks }: { e: Extract<ConvEvent, { kind: 'tool' }>; agentTasks?: AgentTask[] }) {
  if (e.name === 'TodoWrite') return <TodoList e={e} />;
  if (e.name === 'Task') return <TaskAgent e={e} task={agentTasks?.find(t => t.toolUseId === e.toolUseId)} />;
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

/** Cabeçalho do card por ferramenta, como a extensão real (Bash/Read/Edit/Write/Grep/Glob/Skill; o resto é o genérico). */
function permHeader(e: Extract<ConvEvent, { kind: 'permission' }>): React.ReactNode {
  const file = <span className="cc-perm-path">{base(e.description)}</span>;
  switch (e.name) {
    case 'Bash': return 'Permitir este comando bash?';
    case 'Read': return <>Permitir ler {file}?</>;
    case 'Edit': case 'MultiEdit': return <>Fazer esta edição em {file}?</>;
    case 'Write': return <>Permitir escrever em {file}?</>;
    case 'Grep': return e.description ? <>Permitir grep em <span className="cc-perm-path">{e.description}</span>?</> : 'Permitir este grep?';
    case 'Glob': return e.description ? <>Permitir busca glob em <span className="cc-perm-path">{e.description}</span>?</> : 'Permitir este glob?';
    case 'Skill': return <>Usar a skill <span className="cc-perm-path">/{e.description}</span>?</>;
    default: return <>Deseja prosseguir com <strong>{e.label}</strong>?</>;
  }
}

/** Confirmação pedida por um MCP: a mensagem dele e, se ele pedir, um campo para digitar (ex.: nome do repositório). */
function ElicitAnswer({ e, onDecide }: { e: Extract<ConvEvent, { kind: 'permission' }>; onDecide?: (d: 'allow' | 'deny' | 'answer', msg?: string) => void }) {
  const [valor, setValor] = useState('');
  const campo = e.inputText;
  const confirmar = () => { if (campo) { if (valor.trim()) onDecide?.('answer', valor.trim()); } else onDecide?.('allow'); };
  return (
    <div className="cc-perm" tabIndex={0} onKeyDown={ev => { if (ev.key === 'Escape') { ev.preventDefault(); onDecide?.('deny'); } }}>
      <div className="cc-perm-bg" />
      <div className="cc-perm-content">
        <div className="cc-perm-head"><strong>{e.label}</strong> pede confirmação</div>
        <div className="cc-perm-desc" style={{ whiteSpace: 'pre-wrap' }}>{e.description}</div>
      </div>
      <div className="cc-perm-actions">
        {campo && <input className="cc-perm-reject" autoFocus placeholder={`Digite ${campo}`} value={valor} onChange={ev => setValor(ev.target.value)}
          onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); confirmar(); } }} />}
        <button className="cc-perm-btn" disabled={!!campo && !valor.trim()} onClick={confirmar}><span className="cc-perm-num">1</span> Confirmar</button>
        <button className="cc-perm-btn" onClick={() => onDecide?.('deny')}><span className="cc-perm-num">2</span> Recusar</button>
      </div>
      <div className="cc-hints">Esc para recusar</div>
    </div>
  );
}

export function Permission({ e, onDecide }: { e: Extract<ConvEvent, { kind: 'permission' }>; onDecide?: (d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) => void }) {
  const isAsk = !!(e.questions && e.questions.length);
  const [focused, setFocused] = useState(0);
  const [reject, setReject] = useState('');
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
  if (e.name === 'Elicitation') return <ElicitAnswer e={e} onDecide={onDecide} />;
  const isBash = e.name === 'Bash';
  const isFile = e.name === 'Read' || e.name === 'Edit' || e.name === 'MultiEdit' || e.name === 'Write';
  // Root aprova comando a comando (policy.ts): "não perguntar de novo" seria ignorado, então nem aparece.
  const semSempre = e.name.startsWith('mcp__orion-root__');
  // Atalhos da extensão real: 1/2/3 escolhem, Esc cancela (= Não), Enter no campo envia "Não, e faça isto".
  function onKey(ev: React.KeyboardEvent) {
    const inInput = (ev.target as HTMLElement).tagName === 'INPUT';
    if (ev.key === 'Escape') { ev.preventDefault(); onDecide?.('deny', reject.trim() || undefined); return; }
    if (inInput) return;
    if (ev.key === '1') onDecide?.('allow');
    else if (ev.key === '2' && !semSempre) onDecide?.('allow_always');
    else if (ev.key === '3') onDecide?.('deny');
  }
  return (
    <div className="cc-perm" tabIndex={0} data-focused-index={focused} onKeyDown={onKey}>
      <div className="cc-perm-bg" />
      <div className="cc-perm-content">
        <div className="cc-perm-head">{permHeader(e)}</div>
        {isBash && <>
          <div className="cc-perm-input cc-perm-bash">{e.inputText}</div>
          {e.description && e.description !== e.inputText && <div className="cc-perm-desc">{e.description}</div>}
        </>}
        {!isBash && !isFile && e.inputText && (
          <div className="cc-perm-desc"><details><summary><span>Detalhes</span><Chevron size={12} className="cc-perm-chev" /></summary><pre className="cc-perm-json">{e.inputText}</pre></details></div>
        )}
      </div>
      <div className="cc-perm-actions">
        <button className="cc-perm-btn" onFocus={() => setFocused(0)} onClick={() => onDecide?.('allow')}><span className="cc-perm-num">1</span> Sim</button>
        {!semSempre && <button className="cc-perm-btn" onFocus={() => setFocused(1)} onClick={() => onDecide?.('allow_always')}><span className="cc-perm-num">2</span> Sim, e não perguntar de novo</button>}
        <button className="cc-perm-btn" onFocus={() => setFocused(2)} onClick={() => onDecide?.('deny')}><span className="cc-perm-num">3</span> Não</button>
        <input className="cc-perm-reject" placeholder="Diga ao Claude o que fazer em vez disso" value={reject} onChange={ev => setReject(ev.target.value)} onFocus={() => setFocused(3)}
          onKeyDown={ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); onDecide?.('deny', reject.trim() || undefined); } }} />
      </div>
      <div className="cc-hints">Esc para cancelar</div>
    </div>
  );
}

/**
 * Card de permissão **docado**, fora da `cc-timeline` que rola — montado por `ClaudePage.tsx` como
 * irmão do `Composer`, nunca dentro do histórico (ver PARIDADE.md, "Card de permissão docado"; achado
 * lendo `webview/index.js`/`index.css` v2.1.282 da extensão real extraída em
 * `/srv/orion-reference/vscode-extension/extension/webview/`):
 * - JSX real: o card (`qW0`) é filho de um `div.permissionsContainer_07S1Yg` que, por sua vez, é
 *   irmão do composer de verdade (`F5`) dentro de `div.inputContainer_07S1Yg` — nunca dentro do
 *   `messagesContainer_07S1Yg` que rola.
 * - CSS real: `.inputContainer_07S1Yg{position:absolute;display:flex;z-index:20;flex-direction:column;
 *   max-width:680px;margin:0 auto;bottom:16px;left:16px;right:16px}` — um overlay fixo ancorado no
 *   rodapé da viewport, POR CIMA da área que rola (que por sua vez ganha um spacer no próprio fim, com
 *   altura medida por `ResizeObserver` do `inputContainer`, pra nunca esconder a última mensagem atrás
 *   dele).
 *   **Atualizado na rodada 7 (28/09/2026, "layout flutuante do composer" — pedido ao vivo do Bayerl,
 *   apontando pra esta MESMA extensão como referência: "a UI da tela [tem] que ser igual do claude do
 *   antigravity... o input não ocupa 100% da tela... fica no meio... o texto nasce em cima dele... mas
 *   se eu rolo a tela ele passa por trás com uma camada"; ver PARIDADE.md "Layout flutuante do
 *   composer" pra evidência completa)**: até então (rodada 6) o Orion usava uma alternativa mais
 *   simples — `.cc-dock` como mais um item do grid vertical de `.cc-main`, que só crescia pra cima e
 *   empurrava `.cc-scroll`, sem overlay nem medição de altura em JS. Essa alternativa foi substituída
 *   pela mecânica real ponto a ponto: `.cc-float` (ver `claude.css`) agora É `position:absolute`,
 *   mesmos valores exatos acima, montado por `ClaudePage.tsx` com um `ResizeObserver` próprio
 *   (`floatRef`/`floatHeight`) alimentando o spacer no fim de `.cc-scroll` — mesmo mecanismo do
 *   `U`/`V`/`z` reais (`new ResizeObserver(es=>{for(let e of es)V(e.contentRect.height)})` observando
 *   o próprio nó do `inputContainer`).
 * - Sem transição/animação de entrada de propósito: conferido exaustivamente (toda regra CSS de
 *   `permissionRequestContainer_qlaBag`/`permissionsContainer_07S1Yg`/`inputContainer_07S1Yg`, todo
 *   `@keyframes` do bundle, e `grep` por `.animate(` no JS inteiro) — a extensão real NÃO tem nenhuma
 *   animação CSS nem chamada de Web Animations API ligada à entrada desse card; ele aparece por
 *   montagem condicional simples (`h8 && F("div",{...})`). Reproduzido igual aqui — nenhum
 *   `@keyframes`/`transition` novo em `claude.css` pra isso, de propósito, pra não inventar uma
 *   animação que a extensão de verdade não tem.
 * - Só UM card por vez: `event` já vem pré-escolhido de `currentPermission` (mapper.ts) — o primeiro
 *   pedido ainda pendente, mesma regra `permissionRequests.value[0]` da extensão real. `undefined` →
 *   não renderiza nada (o card some assim que é decidido).
 * - Reaproveita o `Permission` de cima (mesmo componente que decidia Bash/Edit e `AskUserQuestion`
 *   antes, inline) — só muda ONDE ele é montado, não o que ele renderiza.
 */
export function PermissionDock({ event, onDecide }: { event?: Extract<ConvEvent, { kind: 'permission' }>; onDecide?: (id: string, d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) => void }) {
  if (!event) return null;
  return (
    <div className="cc-perm-dock">
      <Permission e={event} onDecide={(d, msg) => onDecide?.(event.id, d, msg)} />
    </div>
  );
}

/**
 * Anexos de uma mensagem do usuário já enviada. Antes desta rodada (28/09/2026, popup de imagem —
 * ver PARIDADE.md) era só um chip com ícone + nome, sem miniatura nenhuma no histórico — a nota
 * persistida (`user_prompt`) só guardava `kind`/`name`/`media_type`, sem jeito de buscar a imagem de
 * volta. Agora, quando `attachmentImageUrl` (mapper.ts) resolve uma URL (imagem com `path`
 * persistido — anexos enviados a partir desta rodada), o chip mostra a miniatura de verdade e abre o
 * mesmo `Lightbox` do compositor ao clicar. Anexos antigos (sem `path`) ou não-imagem continuam com
 * o chip de ícone + nome de sempre — nunca um `<img>` quebrado.
 */
/**
 * Texto da mensagem do usuário — `qH0` real com `maxHeight:60`: mais alto que 60px fica recolhido com
 * esmaecimento e um botão "Mostrar mais" no canto (visível no hover/foco); aberto, "Mostrar menos".
 */
function UserText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (ref.current) setTall(ref.current.scrollHeight > 60); }, [text]);
  const clipped = tall && !open;
  return (
    <div className="cc-user-expandable">
      <div className="cc-user-wrap">
        <div ref={ref} className={`cc-user-text ${clipped ? 'is-collapsed' : ''}`} style={clipped ? { maxHeight: 60 } : undefined}>
          {text}
          {clipped && <div className="cc-user-fade" />}
        </div>
        {clipped && <div className="cc-user-more"><button type="button" className="cc-user-expand" onClick={() => setOpen(true)}>Mostrar mais</button></div>}
      </div>
      {open && tall && <div className="cc-user-more is-open"><button type="button" className="cc-user-expand" onClick={() => setOpen(false)}>Mostrar menos</button></div>}
    </div>
  );
}

/** Foto de quem escreveu (rota por nome); sem foto, cai na inicial. */
// Nome completo por primeiro nome ("danilo" -> "Danilo Bayerl"), buscado uma vez por carga da página.
let displayNames: Promise<Record<string, string>> | null = null;
function useDisplayName(name: string): string {
  const [full, setFull] = useState(name);
  useEffect(() => {
    displayNames ??= api<{ names: Record<string, string> }>('/api/profile/display-names').then(r => r.names).catch(() => ({}));
    let alive = true;
    displayNames.then(n => { if (alive) setFull(n[name.toLowerCase()] || name); });
    return () => { alive = false; };
  }, [name]);
  return full;
}

function UserName({ name }: { name: string }) {
  return <div className="cc-user-name">{useDisplayName(name)}</div>;
}

function UserAvatar({ name }: { name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="cc-user-avatar" title={name} aria-hidden="true">
      {failed
        ? <span>{name.charAt(0).toUpperCase()}</span>
        : <img src={`/api/profile/avatar/by-name/${encodeURIComponent(name)}`} alt="" loading="lazy" onError={() => setFailed(true)} />}
    </div>
  );
}

function Attachments({ items }: { items: UserAttachment[] }) {
  const [preview, setPreview] = useState<number | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const images: LightboxImage[] = items.flatMap(a => { const src = attachmentImageUrl(a); return src ? [{ src, alt: a.name }] : []; });
  return (
    <div className="cc-user-attach">
      {items.map((a, i) => {
        const url = attachmentImageUrl(a);
        return (
          <span key={i} className="cc-attach is-chip" title={a.name} role={url ? 'button' : undefined} tabIndex={url ? 0 : undefined}
            onClick={url ? () => setPreview(images.findIndex(m => m.src === url)) : undefined}
            onKeyDown={url ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreview(images.findIndex(m => m.src === url)); } } : undefined}>
            {url
              ? <img className="cc-attach-thumb" src={url} alt="" />
              : <span className="cc-attach-ico">{a.kind === 'image' ? <Image size={12} /> : <File size={12} />}</span>}
            <span className="cc-attach-name">{a.name}</span>
          </span>
        );
      })}
      <Lightbox images={images} index={preview} onClose={closePreview} />
    </div>
  );
}

function Result({ e }: { e: Extract<ConvEvent, { kind: 'result' }> }) {
  if (!e.ok) return <div className="cc-result is-error">Encerrou com erro: {e.error}</div>;
  const tokens = (e.inputTokens !== undefined || e.outputTokens !== undefined)
    ? ` · ${formatTokens(e.inputTokens)}↑ / ${formatTokens(e.outputTokens)}↓ tokens` : '';
  return <div className="cc-result">Concluído · {formatDuration(e.durationMs)} · {e.turns ?? '—'} turnos{tokens}</div>;
}

function dotClass(e: ConvEvent): string {
  switch (e.kind) {
    case 'tool': return e.status === 'success' ? 'dot-success' : e.status === 'failure' ? 'dot-failure' : e.status === 'warning' ? 'dot-warning' : e.status === 'waiting' ? 'dot-pending' : 'dot-progress';
    case 'permission': return e.decision === 'timeout' ? 'dot-warning' : e.decision ? 'dot-success' : 'dot-pending';
    case 'result': return e.ok ? 'dot-success' : 'dot-failure';
    case 'thinking': return e.streaming ? 'dot-progress' : '';
    default: return '';
  }
}

/**
 * Indicador "pensando" ao vivo — ícone (glifo em ciclo, dá impressão de pulsar de tamanho) + palavra
 * em inglês trocando periodicamente. Renderizado a partir do evento sintético `kind:'busy'` (ver
 * `toConvEvents` em live.ts) — mesma condição de `visiblyBusy && !permissionRequests.length` da
 * extensão real: aparece assim que o turno começa a rodar (não só antes do 1º token) e continua
 * visível durante todo o turno, sumindo só quando um pedido de permissão aparece ou o turno termina
 * (ver mapper.ts, comentário de `SPINNER_GLYPHS`/`SPINNER_WORDS` pros achados completos e
 * PARIDADE.md). Como o React casa este elemento pela `key` fixa `live-busy` (ver Timeline abaixo),
 * ele só desmonta/remonta quando o indicador some/reaparece de verdade — igual à extensão real, cujo
 * componente `Re` só é instanciado enquanto a condição é verdadeira — então o ciclo de glifo e o
 * cronograma de troca de palavra não reiniciam a cada streaming parcial, só numa transição real de
 * visibilidade.
 */
function ThinkingIndicator() {
  const [glyphStep, setGlyphStep] = useState(0);
  const [word, setWord] = useState(() => pickSpinnerWord());
  useEffect(() => {
    const t = setInterval(() => setGlyphStep(s => s + 1), SPINNER_GLYPH_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let n = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fire = () => {
      setWord(pickSpinnerWord());
      n++;
      timer = setTimeout(fire, spinnerWordDelayMs(n));
    };
    timer = setTimeout(fire, spinnerWordDelayMs(n));
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="cc-live" aria-hidden="true">
      <span className="cc-live-icon">{spinnerGlyphAt(glyphStep)}</span>
      <span key={word} className="cc-live-word">{word}…</span>
    </div>
  );
}

/**
 * Linhas dobráveis de subagente com overflow — porta do componente real `MA1({tasks})`/`h95`/`y95`
 * do webview v2.1.283 (ver PARIDADE-agentmap.md): enquanto subagentes rodam, uma linha por agente
 * (`data-testid="focus-subagent-row"`, mesmos testids da extensão real) com descrição + último tool
 * (`agentRowLabel`) e decorrido/telemetria (`agentRowMeta`); com 5+ agentes, só 3 visíveis e o resto
 * colapsado numa linha `+N outros agentes` (`data-testid="focus-subagent-overflow-row"`) com a
 * telemetria COMBINADA (`agentOverflowMeta`). Clicar no overflow expande todas; expandido, a última
 * linha ("Recolher" — label real "Collapse", PT-BR como o resto da tela; testid real
 * `focus-fold-end-row`) colapsa de volta, com a contagem dos que vão se esconder no aria-label.
 * Tique de 1s pro decorrido ao vivo, mesmo padrão do AgentMap — o componente só monta enquanto
 * existe agente rodando (ver Timeline abaixo), então o timer morre sozinho quando tudo termina.
 */
function SubagentRows({ tasks }: { tasks: AgentTask[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const { visible, overflow } = splitAgentRows(tasks);
  const shown = expanded ? tasks : visible;
  const row = (t: AgentTask) => (
    <div key={t.toolUseId} className="cc-subagent-row" data-testid="focus-subagent-row">
      <label className="cc-subagent-label">{agentRowLabel(t)}</label>
      <span className="cc-subagent-meta">{agentRowMeta(t, now)}</span>
    </div>
  );
  return (
    <div className="cc-subagent-rows">
      {shown.map(row)}
      {!expanded && overflow.length > 0 && (
        <div className="cc-subagent-row is-toggle" data-testid="focus-subagent-overflow-row" role="button" tabIndex={0}
          aria-expanded={false} aria-label={`${agentOverflowLabel(overflow.length)} · expandir`}
          onClick={() => setExpanded(true)}
          onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setExpanded(true); } }}>
          <label className="cc-subagent-label">{agentOverflowLabel(overflow.length)}</label>
          <span className="cc-subagent-meta">{agentOverflowMeta(overflow, now)}</span>
        </div>
      )}
      {expanded && overflow.length > 0 && (
        <div className="cc-subagent-row is-toggle" data-testid="focus-fold-end-row" role="button" tabIndex={0}
          aria-expanded={true} aria-label={`Recolher ${agentOverflowLabel(overflow.length).replace(/^\+/, '')}`}
          onClick={() => setExpanded(false)}
          onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setExpanded(false); } }}>
          <label className="cc-subagent-label">Recolher</label>
          <Chevron size={10} className="cc-chev is-open" />
        </div>
      )}
    </div>
  );
}

export default function Timeline({ events, onDecide, agentTasks, onResend }: { events: ConvEvent[]; onDecide?: (id: string, d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) => void; agentTasks?: AgentTask[]; onResend?: (prompt: string, attachments?: UserAttachment[]) => void }) {
  // Colapsa fileiras de "expirado" consecutivas (deploy com restarts seguidos órfa vários pedidos
  // de permissão de uma vez — ver foldExpiredPermissions) num único bubble com contagem.
  const folded = useMemo(() => foldExpiredPermissions(events), [events]);
  // Só agentes ATIVOS entram nas linhas dobráveis — mesma seleção do componente real (`MA1` recebe
  // as tasks do fold de "rodando"); concluídos/falhos já têm a linha `TaskAgent` de sempre acima.
  const liveAgents = useMemo(() => (agentTasks ?? []).filter(t => t.status === 'running' || t.status === 'waiting'), [agentTasks]);
  // Agrupa em turnos (cada mensagem do usuário abre um), igual ao `turn_07S1Yg` do plugin: a mensagem
  // do usuário fica `position: sticky` no topo só enquanto o turno dela está na tela; o próximo turno
  // empurra e assume o lugar (ver .cc-turn / .cc-user-row.is-sticky no claude.css).
  const turns = useMemo(() => {
    const out: ConvEvent[][] = [];
    for (const e of folded) {
      if (e.kind === 'user' || out.length === 0) out.push([]);
      out[out.length - 1].push(e);
    }
    return out;
  }, [folded]);
  const renderEvent = (e: ConvEvent) => {
        if (e.kind === 'system') return null;
        // Result com erro (SDK caiu, turno cortado sem retomada — ver NAO_RETOMADA em routes/claude.ts):
        // antes voltava null junto com o "Concluído" (que segue escondido, igual à extensão), então erro
        // de sessão era invisível. ponytail: casa o texto pra decidir o botão em vez de um campo novo.
        if (e.kind === 'result') return e.ok ? null : (
          <div key={e.id} className="cc-msg dot-failure">
            <Result e={e} />
            {onResend && e.error?.includes('não retomado automaticamente') ? <button type="button" className="cc-btn cc-blocked-btn" onClick={() => onResend('Continue de onde parou.')}>Continuar de onde parou</button> : null}
          </div>
        );
        // Permissão pendente (sem decisão) ou já decidida (allow/allow_always/deny/answer): nenhuma
        // das duas aparece mais aqui. A pendente foi pro card docado (PermissionDock, montado por
        // ClaudePage.tsx — ver currentPermission em mapper.ts); a decidida não deixa NENHUM rastro no
        // histórico — igual à extensão real (achado lendo webview/index.js v2.1.282: depois de
        // decidido, o único traço que sobra é o próprio dot de status do tool_use, nunca um bubble
        // "Permitido"/"Você respondeu" na timeline — ver PARIDADE.md). Único evento de permissão que
        // continua aqui: 'timeout' (expirado) — sem equivalente na extensão real (o processo dela não
        // reinicia do jeito que o Orion reinicia; ver foldExpiredPermissions) e sem ele o usuário não
        // teria NENHUM jeito de saber que aquele pedido nunca mais vai ser respondido.
        // Pedidos de permissão nunca viram linha na conversa (igual à extensão: vivem só no card flutuante).
        if (e.kind === 'permission') return null;
        if (e.kind === 'busy') return <ThinkingIndicator key={e.id} />;
        if (e.kind === 'blocked') {
          // O prompt guardado vem com o prefixo "[Nome] " que o servidor põe (header.ts); no reenvio
          // ele põe de novo, então sai aqui.
          const pm = /^\[([^\]\n]{1,40})\]\s*/.exec(e.prompt);
          const texto = pm ? e.prompt.slice(pm[0].length) : e.prompt;
          return (
            <div key={e.id} className="cc-msg dot-failure">
              <div className="cc-blocked">
                <div><b>Mensagem não entregue.</b> Um hook bloqueou o envio e o Claude não viu esta mensagem.</div>
                <div className="cc-blocked-reason">{e.reason}</div>
                {onResend && (texto || e.attachments?.length) ? <button type="button" className="cc-btn cc-blocked-btn" onClick={() => onResend(texto, e.attachments)}>Reenviar</button> : null}
              </div>
            </div>
          );
        }
        if (e.kind === 'user') {
          // Sessão multi-pessoa: o texto chega como "[Nome] ...". Vira card com foto + nome dentro.
          const m = /^\[([^\]\n]{1,40})\]\s*/.exec(e.text);
          const sticky = e.text ? ' is-sticky' : '';
          return (
            <div key={e.id} className={`cc-user-row${sticky}`}>
              <div className={`cc-user${m ? ' has-avatar' : ''}`}>
                {m && <UserAvatar name={m[1]} />}
                <div className="cc-user-body">
                  {m && <UserName name={m[1]} />}
                  {e.text && <UserText text={m ? e.text.slice(m[0].length) : e.text} />}
                  {e.attachments && e.attachments.length > 0 && <Attachments items={e.attachments} />}
                </div>
              </div>
            </div>
          );
        }
        return (
          <div key={e.id} className={`cc-msg ${dotClass(e)}`}>
            {e.kind === 'text' && <AssistantText e={e} />}
            {e.kind === 'thinking' && <Thinking e={e} />}
            {e.kind === 'tool' && <ToolBlock e={e} agentTasks={agentTasks} />}
          </div>
        );
  };
  return (
    <div className="cc-timeline">
      {turns.map((t, i) => <div key={t[0]?.id ?? i} className="cc-turn">{t.map(renderEvent)}</div>)}
      {liveAgents.length > 0 && <SubagentRows tasks={liveAgents} />}
    </div>
  );
}
