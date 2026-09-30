import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Bolt, Clock, Plus, Chevron, X, Image, File, GitBranch, Mic, AgentsPill, AddPlus, SendArrow, SlashCmd, StopSquare, ModeManual, ModeAcceptEdits, ModePlan, ModeAuto } from './icons';
import { MODE_LABEL, MODE_DESC, MODE_ORDER, EFFORT_LABEL, EFFORT_ORDER, MODEL_LABEL, MODEL_ORDER, ULTRACODE_MENU_LABEL, effortPillLabel, type Mode, type Effort, type EffortChoice, type ModelAlias, type OutputStyleInfo, type Project, claudeApi } from './api';
import { cycleMessageIndex, validateWorktreeName, isMacPlatform, micShortcutLabel, composeDictationText, agentsPillCountLabel, agentsPillTitle, type AgentsPillDot, type CycleState } from './mapper';
import type { FastModeState } from './live';
import type { SlashCommandInfo } from './types';
import { pasteFilename } from '../pages/driveUtils';
import Lightbox, { type LightboxImage } from './Lightbox';
import PlainInput, { type PlainInputHandle } from './PlainInput';

/**
 * Comandos de barra fixos: só usados como fallback antes de a sessão ter uma Query viva (rascunho
 * novo, ou reconexão ainda não recebeu o evento 'hello'/'commands' — ver PARIDADE.md seção 5). Com a
 * sessão rodando, a lista real vem de `Query.supportedCommands()` (`server/claude/runner.ts`) via prop
 * `commands` — inclui skills, comandos de projeto (`.claude/commands/*.md`) e os builtin.
 */
const SLASH_FALLBACK: { cmd: string; desc: string }[] = [
  { cmd: '/clear', desc: 'Limpa o contexto da conversa' },
  { cmd: '/compact', desc: 'Resume o histórico para liberar contexto' },
  { cmd: '/context', desc: 'Mostra o uso da janela de contexto' },
  { cmd: '/cost', desc: 'Mostra o uso de tokens da sessão' },
];

/** Anexo pendente: o arquivo ainda em memória, com miniatura (objectURL) quando é imagem. */
type Pending = { id: string; file: File; name: string; isImage: boolean; url?: string };

let uid = 0;
function toPending(file: File): Pending {
  const isImage = (file.type || '').startsWith('image/');
  return { id: `att-${++uid}`, file, name: file.name || 'arquivo', isImage, url: isImage ? URL.createObjectURL(file) : undefined };
}

/** Pill de anexo pendente, cópia do `ip` da extensão real: bloco inteiro clicável, dimensões da imagem, "x" só no hover. */
function AttachPill({ a, onOpen, onRemove }: { a: Pending; onOpen: () => void; onRemove: () => void }) {
  const [dims, setDims] = useState<string>();
  const clickable = a.isImage && !!a.url;
  return (
    <div className="cc-attach" title={a.name} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } } : undefined}>
      {a.url
        ? <img className="cc-attach-thumb" src={a.url} alt="" onLoad={e => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} />
        : <span className="cc-attach-ico">{a.isImage ? <Image size={12} /> : <File size={12} />}</span>}
      <span className="cc-attach-name">{a.name}</span>
      {dims && <span className="cc-attach-meta">{dims}</span>}
      <button type="button" className="cc-attach-x" onClick={e => { e.stopPropagation(); onRemove(); }} title="Remover anexo"><X size={12} /></button>
    </div>
  );
}

function Menu({ open, onClose, children, className = '' }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  if (!open) return null;
  return (
    <>
      <div className="cc-menu-backdrop" onClick={onClose} />
      <div className={`cc-menu ${className}`} role="menu">{children}</div>
    </>
  );
}

/**
 * Controle deslizante de esforço com o degrau extra "Ultracode" — cópia do componente `ye` da
 * extensão real (webview v2.1.283, classes `toggle/fill/fillUltracode/notch/notchUltracode/thumb`
 * `_P1HaRA`; ver PARIDADE-seletor.md): trilho de 76×18px, um notch por nível + um último notch
 * Ultracode (sempre na cor própria), preenchimento até o thumb (na cor Ultracode quando ele está
 * selecionado), clique OU arrasto (pointer capture) escolhem o degrau mais próximo. Mesmos cálculos
 * de posição (`calc()` com --thumb-size/--thumb-inset) e o mesmo comportamento de `P(O)`: o último
 * índice chama `onSelectUltracode`, os demais `onSelect(nível)`.
 */
function EffortSlider({ effort, onSelect, onSelectUltracode }: { effort: EffortChoice; onSelect: (e: Effort) => void; onSelectUltracode: () => void }) {
  const drag = useRef<number | null>(null);
  const total = EFFORT_ORDER.length + 1; // 5 níveis reais + o degrau Ultracode
  const idx = effort === 'ultracode' ? total - 1 : Math.max(0, EFFORT_ORDER.indexOf(effort));
  const frac = idx / (total - 1);
  const span = '(100% - var(--thumb-size) - 2 * var(--thumb-inset))';
  const thumbLeft = `calc(var(--thumb-inset) + ${frac} * ${span})`;
  const fillWidth = `calc(var(--thumb-inset) + ${frac} * ${span} + var(--thumb-size) + var(--thumb-inset))`;
  const notchLeft = (f: number) => `calc(var(--thumb-inset) + ${f} * ${span} + var(--thumb-size) / 2)`;
  function indexAt(e: PointerEvent<HTMLButtonElement>): number {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return Math.round(f * (total - 1));
  }
  function pick(i: number) {
    if (i === total - 1) { onSelectUltracode(); return; }
    const level = EFFORT_ORDER[i];
    if (level) onSelect(level);
  }
  function down(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = indexAt(e);
    drag.current = i;
    pick(i);
  }
  function move(e: PointerEvent<HTMLButtonElement>) {
    if (drag.current === null) return;
    const i = indexAt(e);
    if (i === drag.current) return;
    drag.current = i;
    pick(i);
  }
  function up() { drag.current = null; }
  return (
    <button type="button" className="cc-effort-toggle" title="Clique ou arraste para definir o esforço"
      onMouseDown={e => e.preventDefault()} onPointerDown={down} onPointerMove={move}
      onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onClick={e => e.stopPropagation()}>
      <div className={`cc-effort-fill ${effort === 'ultracode' ? 'is-ultracode' : ''}`} style={{ width: fillWidth }} />
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`cc-effort-notch ${i === total - 1 ? 'is-ultracode' : ''}`} style={{ left: notchLeft(i / (total - 1)) }} />
      ))}
      <div className="cc-effort-thumb" style={{ left: thumbLeft }} />
    </button>
  );
}

/** Ícone pequeno do modo de permissão — `iconV2Small` real por modo (FP1/sB0/tB0/iB0). */
function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === 'acceptEdits') return <ModeAcceptEdits />;
  if (mode === 'plan') return <ModePlan />;
  if (mode === 'auto') return <ModeAuto />;
  return <ModeManual />;
}
/** "claude-opus-5-5" → "Opus 5.5", "claude-fable-5-1" → "Fable 5.1", "claude-haiku-4-5-20251001" → "Haiku 4.5"; outros textos passam intactos. */
export function prettyModel(label: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(label);
  if (!m) return label;
  const nome = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${nome} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

export default function Composer({ onSend, onStop, running, mode, onMode, effort, onEffort, model, onModel, modelLabel, history, commands, sessionId, projects, projectId, onProject, worktreeName, onWorktreeName, elapsed, fastMode, agents, onAgents, outputStyles, outputStyle, onOutputStyle, onBuildStyle }: {
  onSend: (text: string, files: File[]) => void | Promise<void>; onStop?: () => void; running: boolean; mode: Mode; onMode: (m: Mode) => void;
  effort?: EffortChoice; onEffort?: (e: EffortChoice) => void; model?: ModelAlias; onModel?: (m: ModelAlias) => void; modelLabel: string;
  /** Mensagens já enviadas nesta sessão, mais recente primeiro — alimenta o recall ArrowUp/ArrowDown (ver cycleMessageIndex). */
  history?: string[];
  /** Comandos de barra reais da sessão (Query.supportedCommands(), via ClaudePage); sem isso, usa SLASH_FALLBACK. */
  commands?: SlashCommandInfo[];
  /** Id da sessão ativa — só pra saber quando trocou de aba e sair de um ciclo de recall em andamento. */
  sessionId?: string;
  projects?: Project[]; projectId?: number | null; onProject?: (id: number | null) => void;
  /**
   * "Aba Claude" — criar worktree direto pela UI do chat (ver PARIDADE.md seção 14, botão
   * `createWorktreeButton`/painel `worktreeInput*` da extensão real). Só faz sentido junto com
   * `projects`/`onProject` (rascunho de sessão nova — só aí ainda dá pra escolher onde o worktree
   * nasce); nome vazio = sessão normal, sem worktree, como sempre foi.
   */
  worktreeName?: string; onWorktreeName?: (name: string) => void;
  elapsed?: string;
  /** Estado do fast mode da sessão (`fast_mode_state` do SDK, via live.ts) — alimenta a legenda `sparkLegend` e o atributo `data-spark`; ausente/'off' = indicador escondido (o caso de hoje, ver PARIDADE-seletor.md). */
  fastMode?: FastModeState;
  /**
   * "Agents pill" — gatilho do Mapa de agentes no rodapé do compositor, perto do model pill
   * (29/09/2026, ver PARIDADE-agentmap.md): botão real `agentsPill` do webview v2.1.283 (className
   * `${modelPill} ${agentsPill}`, atributo `data-agents-dot` com o estado que pinta o dot, aria-label
   * `"{N} agent(s)} · {status}"`). `total` = quantos subagentes a sessão já teve (o pill só aparece
   * com ≥1, nunca numa sessão sem Task nenhum); `count` = quantos ATIVOS agora (porta de `pS` real);
   * `dot` = estado agregado (porta de `oE1` real, ver `agentsPillDot` em mapper.ts).
   */
  agents?: { total: number; count: number; dot: AgentsPillDot };
  onAgents?: () => void;
  /**
   * "Aba Claude" — seletor de output style (menu "Output styles" da extensão real; ver
   * OutputStyles.tsx e PARIDADE-marketplace.md). Só aparece com `onOutputStyle` (sessão de verdade
   * aberta — rascunho ainda não tem linha no Postgres pra persistir, mesma razão de setMode/
   * setModel ao vivo só valerem pra sessão real). `outputStyle` = nome/slug atual ('default' = sem
   * estilo); `onBuildStyle` abre o assistente "Construir um estilo personalizado".
   */
  outputStyles?: OutputStyleInfo[]; outputStyle?: string; onOutputStyle?: (nome: string) => void; onBuildStyle?: () => void;
}) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<'' | 'mode' | 'effort' | 'model' | 'slash' | 'worktree' | 'style'>('');
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Popup/galeria de imagem (Lightbox) aberto no índice do anexo clicado — ver claude/Lightbox.tsx.
  const [preview, setPreview] = useState<number | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  // Ciclo de recall de mensagens (ArrowUp/ArrowDown com o cursor no início/fim do texto — ver `key`
  // abaixo e `cycleMessageIndex` em mapper.ts, que espelha `cycleMessage` do webview real).
  const [cycle, setCycle] = useState<CycleState>({ index: -1, saved: '' });
  const ta = useRef<PlainInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Ditado por voz (ver PARIDADE.md/mapper.ts pro achado completo). `micSupported`: calculado 1x —
  // navegador sem Web Speech API (ex. Firefox) esconde o botão inteiro, mesmo padrão de
  // `X.speechToTextEnabled &&` da extensão real (feature-flag esconde tudo, não só desabilita).
  // Gravação própria (MediaRecorder) + transcrição no servidor: funciona em qualquer navegador com microfone.
  const micSupported = useMemo(() => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined', []);
  const textRef = useRef(text);
  textRef.current = text;
  // Rascunho por aba: o compositor é um só para todas as abas; ao trocar, guarda o texto e os
  // anexos da aba que saiu e traz os da que entrou (antes o texto "vazava" para a outra aba).
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const draftsRef = useRef(new Map<string, { text: string; attachments: Pending[] }>());
  const prevSessionRef = useRef(sessionId);
  // Autosave no servidor (por pessoa e sessão): o rascunho volta depois de F5, fechar o navegador ou
  // abrir em outro aparelho. Rascunhos de aba nova ainda sem sessão ("draft-…") ficam só na memória.
  const savedDraftsRef = useRef<Record<string, string> | null>(null);
  const lastSavedRef = useRef<{ id?: string; text: string }>({ text: '' });
  const persistable = (id?: string) => !!id && !id.startsWith('draft-');
  useEffect(() => {
    let alive = true;
    claudeApi.drafts().then(r => {
      if (!alive) return;
      savedDraftsRef.current = r.drafts;
      const id = sessionRef.current;
      // Abriu a página já numa aba: se a caixa ainda está vazia, traz o rascunho salvo dela.
      if (persistable(id) && !textRef.current && r.drafts[id!]) {
        textRef.current = r.drafts[id!];
        lastSavedRef.current = { id, text: r.drafts[id!] };
        setText(r.drafts[id!]);
      }
    }).catch(() => { savedDraftsRef.current = {}; });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const id = sessionId;
    if (!persistable(id) || savedDraftsRef.current === null) return;
    if (lastSavedRef.current.id === id && lastSavedRef.current.text === text) return;
    const t = setTimeout(() => {
      lastSavedRef.current = { id, text };
      savedDraftsRef.current![id!] = text;
      void claudeApi.saveDraft(id!, text).catch(() => { /* tenta de novo na próxima digitação */ });
    }, 600);
    return () => clearTimeout(t);
  }, [text, sessionId]);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev === sessionId) return;
    draftsRef.current.set(prev ?? '', { text: textRef.current, attachments: attachmentsRef.current });
    const next = draftsRef.current.get(sessionId ?? '');
    draftsRef.current.delete(sessionId ?? '');
    prevSessionRef.current = sessionId;
    // Sem rascunho nesta guia: usa o salvo no servidor (vindo de outro aparelho/navegador).
    const nextText = next?.text ?? (persistable(sessionId) ? savedDraftsRef.current?.[sessionId!] ?? '' : '');
    textRef.current = nextText;
    lastSavedRef.current = { id: sessionId, text: nextText };
    setText(nextText);
    setAttachments(next?.attachments ?? []);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [micBusy, setMicBusy] = useState(false);
  const [micRecording, setMicRecording] = useState(false);
  const [micError, setMicError] = useState<string>();
  // Negação permanente de permissão (equivalente a `speechToTextMicDenied` real) — desabilita o botão
  // até o usuário mudar a permissão no navegador; diferente de um erro passageiro.
  const [micDenied, setMicDenied] = useState(false);
  const micRecorderRef = useRef<{ rec: MediaRecorder; stream: MediaStream; cancelled: boolean; session?: string; done: Promise<void> } | null>(null);
  const micPendingRef = useRef<Promise<void> | null>(null);
  // Texto antes/depois do cursor no INÍCIO da gravação, mais o texto final já acumulado nesta
  // gravação — `composeDictationText` sempre recalcula a partir daqui, nunca do valor atual do campo
  // (ver limitação documentada em mapper.ts: digitar durante o ditado pode ser sobrescrito).
  const micBaseRef = useRef<{ before: string; after: string; final: string } | null>(null);

  // Trocou de sessão: sai de um ciclo em andamento (o histórico agora é de outra conversa).
  useEffect(() => { setCycle({ index: -1, saved: '' }); }, [sessionId]);
  // Rascunho ficou vazio (enviado, apagado à mão, ou o próprio ciclo restaurou ''): sai do ciclo —
  // mesmo guard do hook real (`Cq0`: "if (currentInput === '') resetHistory()").
  useEffect(() => { if (text === '') setCycle({ index: -1, saved: '' }); }, [text]);

  // Libera as URLs de objeto ao desmontar (as de cada remoção são liberadas em removeAttachment).
  // Só no desmontar: com [attachments] como dependência, a limpeza rodava a cada anexo novo e revogava as
  // URLs dos anteriores (miniatura e preview quebravam). O ref guarda a lista atual para o desmontar.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => { attachmentsRef.current.forEach(a => a.url && URL.revokeObjectURL(a.url)); }, []);

  function addFiles(list: FileList | File[] | null | undefined) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setAttachments(prev => [...prev, ...files.map(toPending)]);
  }
  function removeAttachment(id: string) {
    setAttachments(prev => { const gone = prev.find(a => a.id === id); if (gone?.url) URL.revokeObjectURL(gone.url); return prev.filter(a => a.id !== id); });
  }
  function onPick(e: ChangeEvent<HTMLInputElement>) { addFiles(e.target.files); e.target.value = ''; }

  async function send() {
    // Enviar gravando (ou transcrevendo): para o microfone, espera o texto entrar e envia junto.
    if (micRecorderRef.current || micPendingRef.current) {
      const pending = micRecorderRef.current?.done ?? micPendingRef.current;
      stopMic();
      await pending;
    }
    const t = textRef.current.trim();
    if (sending || (!t && attachments.length === 0)) return;
    const files = attachments.map(a => new window.File([a.file], pasteFilename(a.name, a.file.type), { type: a.file.type }));
    setSending(true);
    try {
      await onSend(t, files);
      setText('');
      attachments.forEach(a => a.url && URL.revokeObjectURL(a.url));
      setAttachments([]);
    } catch { /* o ClaudePage mostra o erro; mantém o rascunho e os anexos */ }
    finally { setSending(false); }
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    // Digitou "/" gravando: para a gravação (vai abrir o menu de comandos).
    if (e.key === '/' && micRecorderRef.current) stopMic();
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); return; }
    // Recall de mensagens: só quando não há menu aberto (evita brigar com a navegação de um popover)
    // e o cursor está colado no início (ArrowUp) ou no fim (ArrowDown) de TODO o texto — não só da
    // linha atual. É a mesma checagem de posição do cursor da extensão real (`cycleMessage`/`Cq0` no
    // webview decompilado): com texto de várias linhas, ArrowUp no meio continua navegando normal.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !menu && history && history.length && ta.current) {
      const el = ta.current;
      const dir: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
      const sel = el.getSelection();
      const atStart = sel.start === 0 && sel.end === 0;
      const atEnd = sel.start === text.length && sel.end === text.length;
      if ((dir === -1 && atStart) || (dir === 1 && atEnd)) {
        const r = cycleMessageIndex(dir, cycle, history, text);
        if (r) {
          e.preventDefault();
          setCycle({ index: r.index, saved: r.saved });
          setText(r.text);
          // Cursor no início quando ArrowUp mostrou um item do histórico; no fim nos outros casos
          // (espelha N75/O75 do webview real: recall mais antigo começa lido do topo, o resto do fim).
          const pos = dir === -1 && r.index !== -1 ? 0 : r.text.length;
          setTimeout(() => el.setCaret(pos), 0);
        }
      }
    }
  }
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  }
  function onDrop(e: DragEvent<HTMLDivElement>) { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer?.files); }
  function pickSlash(cmd: string) { setText(cmd + ' '); setMenu(''); ta.current?.focus(); }

  /** Para o reconhecimento em andamento (se houver) e limpa o estado de gravação — usado tanto pelo alternar manual quanto pelos efeitos de troca de sessão/desmontagem abaixo. */
  // Ditado: grava o áudio no navegador e manda pro servidor transcrever (Groq, com Whisper local de
  // reserva, ver server/claude/transcribe.ts). O texto entra onde estava o cursor ao começar.
  function stopMic(cancel = false) {
    const cur = micRecorderRef.current;
    if (!cur) return;
    cur.cancelled = cancel;
    micRecorderRef.current = null;
    setMicRecording(false);
    try { if (cur.rec.state !== 'inactive') cur.rec.stop(); } catch { /* já parado */ }
  }
  async function startMic() {
    if (!micSupported || micDenied || micBusy) return;
    const el = ta.current;
    const value = text;
    const cur = el?.getSelection() ?? { start: value.length, end: value.length };
    micBaseRef.current = { before: value.slice(0, cur.start), after: value.slice(cur.end), final: '' };
    setMicError(undefined);
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') setMicDenied(true);
      else setMicError('Não foi possível abrir o microfone');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    let finish!: () => void;
    const entry = { rec, stream, cancelled: false, session: sessionRef.current, done: new Promise<void>(r => { finish = r; }) };
    rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (entry.cancelled) { finish(); return; }
      micPendingRef.current = entry.done;
      const type = rec.mimeType || mime || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      setMicBusy(true);
      try {
        const r = await claudeApi.transcribe(new Blob(chunks, { type }), `ditado.${ext}`);
        // Trocou de aba enquanto gravava/transcrevia: o ditado vai para o rascunho da aba de origem.
        if (entry.session !== sessionRef.current) {
          if (r.text) {
            const key = entry.session ?? '';
            const d = draftsRef.current.get(key) ?? { text: '', attachments: [] };
            draftsRef.current.set(key, { ...d, text: composeDictationText(d.text, '', r.text, '').value });
          }
          return;
        }
        // Insere no texto ATUAL, na posição atual do cursor: se a pessoa digitou algo enquanto
        // transcrevia, nada se perde (antes o texto de quando começou a gravar sobrescrevia).
        const now = textRef.current;
        const base = micBaseRef.current;
        let before = base?.before ?? now, after = base?.after ?? '';
        if (!base || now !== base.before + base.after) {
          const sel = ta.current?.getSelection() ?? { start: now.length, end: now.length };
          before = now.slice(0, sel.start); after = now.slice(sel.end);
        }
        if (r.text) {
          const composed = composeDictationText(before, after, r.text, '');
          textRef.current = composed.value;
          setText(composed.value);
          setTimeout(() => ta.current?.setCaret(composed.cursor), 0);
        }
      } catch (err) { setMicError((err as Error).message || 'Falha ao transcrever'); }
      finally { setMicBusy(false); micPendingRef.current = null; finish(); }
    };
    micRecorderRef.current = entry;
    rec.start();
    setMicRecording(true);
  }
  function toggleMic() {
    if (!micSupported || micDenied) return;
    if (micRecording) stopMic(); else void startMic();
  }
  // Trocou de sessão: para qualquer ditado em andamento (a gravação era pra outra conversa).
  useEffect(() => { if (micRecorderRef.current) stopMic(); }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Desmontagem: nunca deixa o microfone do navegador "preso" ligado.
  useEffect(() => () => { stopMic(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Atalho de teclado ⌘D/Ctrl+D — mesmo achado na extensão real (`micTooltipShortcut`, função `j11()`
  // decide qual mostrar). Alterna gravação (liga/desliga); ver mapper.ts pra simplificação deliberada
  // em relação ao gesto de segurar-e-soltar (push-to-talk) real, não replicado aqui.
  useEffect(() => {
    if (!micSupported) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (micDenied || e.repeat || e.shiftKey || e.altKey) return;
      const mod = isMacPlatform(navigator) ? e.metaKey : e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      toggleMic();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [micSupported, micDenied, micRecording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc foca/desfoca o compositor.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (menu) { setMenu(''); return; }
      if (document.activeElement === ta.current?.el) ta.current?.blur();
      else ta.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const slashOpen = menu === 'slash' || (menu === '' && /^\/\S*$/.test(text.trimStart()) && text.trim().length > 0);
  const slashFilter = text.trimStart();
  // Lista real da sessão (Query.supportedCommands(), via ClaudePage) quando já existe; senão os 4 fixos.
  const slashSource = commands && commands.length ? commands.map(c => ({ cmd: '/' + c.name, desc: c.description })) : SLASH_FALLBACK;
  // Filtra enquanto digita (inclusive com o menu aberto pelo botão): "/cool" acha "/coolify:…" e
  // também nomes que só contêm o trecho, com os que começam pelo trecho primeiro.
  const slashQuery = slashFilter.startsWith('/') ? slashFilter.slice(1).toLowerCase() : '';
  const slashItems = !slashQuery ? slashSource : [
    ...slashSource.filter(s => s.cmd.slice(1).toLowerCase().startsWith(slashQuery)),
    ...slashSource.filter(s => !s.cmd.slice(1).toLowerCase().startsWith(slashQuery) && s.cmd.toLowerCase().includes(slashQuery)),
  ];
  // Validação ao vivo do nome de worktree (ver mapper.ts) — só roda com algo digitado, igual à
  // extensão real (`let U=G?fF0(G):null`): campo vazio nunca mostra "obrigatório" sozinho, porque
  // aqui (diferente da extensão) vazio é um valor válido — "sem worktree, sessão normal".
  const worktreeNameError = worktreeName ? validateWorktreeName(worktreeName) : null;
  const images: LightboxImage[] = attachments.filter(a => a.url).map(a => ({ src: a.url!, alt: a.name }));
  const canSend = !sending && (!!text.trim() || attachments.length > 0 || micRecording || micBusy) && !worktreeNameError;

  return (
    <div className={`cc-composer ${dragOver ? 'is-dragover' : ''}`} data-permission-mode={mode}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
      onDrop={onDrop}
      {...(fastMode && fastMode !== 'off' ? { 'data-spark': fastMode } : {})}>
      {/* Legenda de esforço (pontinhos no canto do composer, cópia do sparkLegend real) removida a pedido do Danilo em 29/09/2026: parecia bug. */}
      <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
      {attachments.length > 0 && (
        <div className="cc-attach-row">
          {attachments.map(a => (
            <AttachPill key={a.id} a={a} onOpen={() => setPreview(images.findIndex(m => m.src === a.url))} onRemove={() => removeAttachment(a.id)} />
          ))}
        </div>
      )}
      <Lightbox images={images} index={preview} onClose={closePreview} />
      {/* autoComplete off: sem a barra de senha/cartão/endereço do iPhone em cima do teclado. */}
      {/* Área editável em vez de <textarea>: sem a barra de senha/cartão do iPhone (ver PlainInput.tsx). */}
      <PlainInput ref={ta} value={text} onChange={setText} onKeyDown={key} onPaste={onPaste}
        placeholder={dragOver ? 'Solte os arquivos aqui…' : running ? 'Enfileirar outra mensagem…' : 'Peça ao Claude para editar…'} />
      {/*
        Ditado por voz — canto superior direito do campo, igual à extensão real
        (`micButtonWrapper_cKsPxg{position:absolute;top:5px;right:0}`, ver PARIDADE.md/mapper.ts).
        Escondido inteiro (não só desabilitado) quando o navegador não suporta Web Speech API — mesmo
        padrão do `X.speechToTextEnabled &&` real (feature-flag esconde tudo).
      */}
      {micSupported && (
        <div className="cc-mic-wrap">
          <button type="button" className={`cc-mic ${micRecording ? 'is-recording' : ''} ${micBusy ? 'is-busy' : ''}`} disabled={micDenied || micBusy} onClick={toggleMic}
            aria-label={micError ? `Erro de ditado: ${micError}` : micDenied ? 'Acesso ao microfone negado' : micRecording ? 'Parar gravação' : 'Ditado por voz'}>
            <Mic size={14} className="cc-mic-icon" />
          </button>
          <span className={`cc-mic-tooltip ${micError ? 'is-error' : ''}`} aria-hidden="true">
            {micError
              ? `Erro de ditado: ${micError}`
              : micDenied
                ? 'Acesso ao microfone negado — permita no navegador'
                : micRecording
                  ? 'Toque para parar'
                  : micBusy
                  ? 'Transcrevendo…'
                  : <>Toque para ditar<span className="cc-mic-tooltip-shortcut">{micShortcutLabel(isMacPlatform(navigator))}</span></>}
          </span>
        </div>
      )}
      {/* Transcrição parcial ("interim") — itálico/cinza, some assim que o trecho é confirmado e vira texto normal no campo (ver composeDictationText em mapper.ts). */}
      {/* Sem a cópia pequena do texto parcial embaixo do microfone: o ditado já aparece no próprio campo. */}
      <div className="cc-composer-foot">
        <button className="cc-foot-btn" title="Anexar arquivos ou imagens" onClick={() => fileInput.current?.click()}><AddPlus /></button>
        <div className="cc-pop">
          <button className="cc-foot-btn" title="Mostrar menu de comandos (/)" onClick={() => { if (micRecorderRef.current) stopMic(); setMenu(m => m === 'slash' ? '' : 'slash'); }}><SlashCmd /></button>
          <Menu open={slashOpen && slashItems.length > 0} onClose={() => setMenu('')} className="cc-menu-up">
            <div className="cc-menu-title">Comandos</div>
            {slashItems.map(s => (
              <button key={s.cmd} className="cc-menu-item" role="menuitem" onClick={() => pickSlash(s.cmd)}>
                <span className="cc-menu-item-name cc-mono">{s.cmd}</span>
                <span className="cc-menu-item-desc">{s.desc}</span>
              </button>
            ))}
          </Menu>
        </div>
        {sending && <span className="cc-pill cc-pill-ghost cc-attach-status">enviando anexos…</span>}
        {elapsed && <span className="cc-foot-btn is-static"><Clock size={14} /><span>{elapsed}</span></span>}
        {projects && onProject && (
          <select className="cc-pill cc-select" value={projectId ?? ''} onChange={e => onProject(e.target.value ? Number(e.target.value) : null)} title="Projeto da nova sessão">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="">Neutro</option>
          </select>
        )}
        {/*
          "Aba Claude" — criar worktree direto pela UI do chat (ver PARIDADE.md seção 14). Só
          aparece junto do seletor de projeto acima (rascunho de sessão nova): na extensão real o
          botão "createWorktreeButton" fica na barra lateral, ao lado de "New session" — mas lá a
          ação é independente de mandar mensagem; aqui toda sessão nasce com um primeiro prompt, então
          faz mais sentido ficar ao lado de "qual projeto", que já é o único outro contexto que só
          existe nesta tela pra uma sessão ainda não criada. Mesmo padrão `cc-pop`/`Menu`/
          `cc-menu-item` já usado pelos seletores de Modelo/Esforço/Modo (copiado literalmente, sem
          inventar interação nova).
        */}
        {projects && onProject && onWorktreeName && projectId != null && (
          <div className="cc-pop">
            <button type="button" className="cc-pill cc-pill-ghost" onClick={() => setMenu(m => m === 'worktree' ? '' : 'worktree')} title="Criar esta sessão num novo git worktree">
              <GitBranch size={12} /> {worktreeName || 'Worktree'}
            </button>
            <Menu open={menu === 'worktree'} onClose={() => setMenu('')} className="cc-menu-up">
              <div className="cc-menu-title">Novo worktree (opcional)</div>
              <div className="cc-worktree-field">
                <input autoFocus value={worktreeName ?? ''} placeholder="ex. minha-feature"
                  onChange={e => onWorktreeName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setMenu(''); } }} />
              </div>
              {worktreeName && worktreeNameError && <div className="cc-worktree-error">{worktreeNameError}</div>}
              {worktreeName && !worktreeNameError && <div className="cc-worktree-status">Cria o worktree ao enviar a 1ª mensagem</div>}
            </Menu>
          </div>
        )}
        {/* Agents pill (ver prop `agents` acima e PARIDADE-agentmap.md): logo antes do model pill,
            mesma vizinhança do real (`w0&&F(pB0,...)` vem imediatamente antes do bloco do model
            picker no rodapé real). Ícone = path literal do `U11` real; dot pintado por
            `data-agents-dot` + classe de estado (mesmas cores dos dots do Mapa de agentes). */}
        {onAgents && agents && agents.total > 0 && (
          <button type="button" className="cc-pill cc-pill-ghost cc-agents-pill" data-agents-dot={agents.dot}
            onClick={onAgents} title={agentsPillTitle(agents.dot)}
            aria-label={`${agentsPillCountLabel(agents.count)} · ${agentsPillTitle(agents.dot)}`}>
            <AgentsPill size={16} />
            <span className={`cc-agents-dot is-${agents.dot}`} data-status-dot={agents.dot} aria-hidden="true" />
            <span>{agentsPillCountLabel(agents.count)}</span>
          </button>
        )}
        {/* modelPill_gGYT1w real: uma pílula só, "Modelo Esforço", sem chevron; o menu traz modelo, esforço (slider) e estilo de saída. */}
        <div className="cc-pop">
          <button className="cc-model-pill" onClick={() => (onModel || onEffort || onOutputStyle) && setMenu(m => m === 'model' ? '' : 'model')} title="Trocar modelo" role="combobox" aria-haspopup="listbox" aria-expanded={menu === 'model'}>
            <span className="cc-model-pill-label">{prettyModel(modelLabel)}</span>
            {onEffort && <> <span className="cc-model-pill-effort">{effortPillLabel(effort ?? 'medium')}</span></>}
          </button>
          <Menu open={menu === 'model'} onClose={() => setMenu('')} className="cc-menu-up">
            {onModel && <>
              <div className="cc-menu-title">Modelo</div>
              {MODEL_ORDER.map(m => (
                <button key={m} className={`cc-menu-item ${m === (model ?? 'default') ? 'is-active' : ''}`} role="menuitem" onClick={() => { onModel(m); setMenu(''); }}>
                  <span className="cc-menu-item-name">{MODEL_LABEL[m]}</span>
                </button>
              ))}
            </>}
            {onEffort && <>
              <div className="cc-menu-title">Esforço</div>
              <div className="cc-effort-row">
                <span className="cc-effort-row-label" title={effort === 'ultracode' ? ULTRACODE_MENU_LABEL : undefined}>
                  <Bolt size={11} /> <span className="cc-effort-inline">({effort === 'ultracode' ? ULTRACODE_MENU_LABEL : EFFORT_LABEL[effort ?? 'medium']})</span>
                </span>
                <EffortSlider effort={effort ?? 'medium'} onSelect={ef => onEffort(ef)} onSelectUltracode={() => onEffort('ultracode')} />
              </div>
              {EFFORT_ORDER.map(ef => (
                <button key={ef} className={`cc-menu-item ${ef === effort ? 'is-active' : ''}`} role="menuitem" onClick={() => { onEffort(ef); setMenu(''); }}>
                  <span className="cc-menu-item-name">{EFFORT_LABEL[ef]}</span>
                </button>
              ))}
              <button className={`cc-menu-item ${effort === 'ultracode' ? 'is-active' : ''}`} role="menuitem" onClick={() => { onEffort('ultracode'); setMenu(''); }}>
                <span className="cc-menu-item-name">{ULTRACODE_MENU_LABEL}</span>
              </button>
            </>}
            {onOutputStyle && <>
              <div className="cc-menu-title">Estilo de saída</div>
              {(outputStyles ?? []).length === 0 && <div className="cc-style-empty">Nenhum estilo de saída disponível</div>}
              {(outputStyles ?? []).map(st => (
                <button key={st.nome} className={`cc-menu-item ${st.nome === (outputStyle ?? 'default') ? 'is-active' : ''}`} role="menuitem" onClick={() => { onOutputStyle(st.nome); setMenu(''); }}>
                  <span className="cc-menu-item-name">{st.label}</span>
                  {st.descricao && <span className="cc-menu-item-desc">{st.descricao}{st.criado_por ? ` · ${st.criado_por}` : ''}</span>}
                </button>
              ))}
              {onBuildStyle && (
                <button className="cc-menu-item cc-style-build" role="menuitem" onClick={() => { onBuildStyle(); setMenu(''); }}>
                  <span className="cc-menu-item-name">Construir um estilo personalizado</span>
                </button>
              )}
            </>}
          </Menu>
        </div>
        <span className="cc-spacer" />
        <div className="cc-pop">
          <button className="cc-foot-btn cc-mode-btn" onClick={() => setMenu(m => m === 'mode' ? '' : 'mode')} title={MODE_DESC[mode]}>
            <ModeIcon mode={mode} /><span>{MODE_LABEL[mode]}</span>
          </button>
          <Menu open={menu === 'mode'} onClose={() => setMenu('')} className="cc-menu-up cc-menu-right">
            <div className="cc-menu-title">Modo de permissão</div>
            {MODE_ORDER.map(m => (
              <button key={m} className={`cc-menu-item ${m === mode ? 'is-active' : ''}`} role="menuitem" onClick={() => { onMode(m); setMenu(''); }}>
                <span className="cc-menu-item-name">{MODE_LABEL[m]}</span>
                <span className="cc-menu-item-desc">{MODE_DESC[m]}</span>
              </button>
            ))}
          </Menu>
        </div>
        {/* Rodando e caixa vazia: Parar. Começou a escrever (ou anexou): vira Enviar, que enfileira. */}
        {running && onStop && !text.trim() && attachments.length === 0 && !micRecording && !micBusy
          ? <button className="cc-send" data-permission-mode={mode} onClick={onStop} aria-label="Parar" title="Parar"><StopSquare className="cc-stop-icon" /></button>
          : <button className="cc-send" data-permission-mode={mode} onClick={() => void send()} disabled={!canSend} aria-label="Enviar mensagem" title="Enviar mensagem"><SendArrow className="cc-send-icon" /></button>}
      </div>
    </div>
  );
}
