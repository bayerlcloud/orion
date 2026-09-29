import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Bolt, Clock, Plus, Slash, Chevron, X, Image, File, GitBranch } from './icons';
import { MODE_LABEL, MODE_DESC, MODE_ORDER, EFFORT_LABEL, EFFORT_ORDER, MODEL_LABEL, MODEL_ORDER, type Mode, type Effort, type ModelAlias, type Project } from './api';
import { cycleMessageIndex, validateWorktreeName, type CycleState } from './mapper';
import type { SlashCommandInfo } from './types';
import { pasteFilename } from '../pages/driveUtils';
import Lightbox, { type LightboxImage } from './Lightbox';

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
  { cmd: '/cost', desc: 'Mostra custo e tokens da sessão' },
];

/** Anexo pendente: o arquivo ainda em memória, com miniatura (objectURL) quando é imagem. */
type Pending = { id: string; file: File; name: string; isImage: boolean; url?: string };

let uid = 0;
function toPending(file: File): Pending {
  const isImage = (file.type || '').startsWith('image/');
  return { id: `att-${++uid}`, file, name: file.name || 'arquivo', isImage, url: isImage ? URL.createObjectURL(file) : undefined };
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

export default function Composer({ onSend, onStop, running, mode, onMode, effort, onEffort, model, onModel, modelLabel, history, commands, sessionId, projects, projectId, onProject, worktreeName, onWorktreeName, elapsed }: {
  onSend: (text: string, files: File[]) => void | Promise<void>; onStop?: () => void; running: boolean; mode: Mode; onMode: (m: Mode) => void;
  effort?: Effort; onEffort?: (e: Effort) => void; model?: ModelAlias; onModel?: (m: ModelAlias) => void; modelLabel: string;
  /** Mensagens já enviadas nesta sessão, mais recente primeiro — alimenta o recall ArrowUp/ArrowDown (ver cycleMessageIndex). */
  history?: string[];
  /** Comandos de barra reais da sessão (Query.supportedCommands(), via ClaudePage); sem isso, usa SLASH_FALLBACK. */
  commands?: SlashCommandInfo[];
  /** Id da sessão ativa — só pra saber quando trocou de aba e sair de um ciclo de recall em andamento. */
  sessionId?: string;
  projects?: Project[]; projectId?: number; onProject?: (id: number) => void;
  /**
   * "Aba Claude" — criar worktree direto pela UI do chat (ver PARIDADE.md seção 14, botão
   * `createWorktreeButton`/painel `worktreeInput*` da extensão real). Só faz sentido junto com
   * `projects`/`onProject` (rascunho de sessão nova — só aí ainda dá pra escolher onde o worktree
   * nasce); nome vazio = sessão normal, sem worktree, como sempre foi.
   */
  worktreeName?: string; onWorktreeName?: (name: string) => void;
  elapsed?: string;
}) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<'' | 'mode' | 'effort' | 'model' | 'slash' | 'worktree'>('');
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Popup de imagem (Lightbox) do anexo pendente clicado — ver claude/Lightbox.tsx. Substitui o
  // "abre em nova aba" (commit 5b445b6) pelo popup real da extensão, pedido ao vivo pelo Bayerl.
  const [preview, setPreview] = useState<LightboxImage | null>(null);
  // Ciclo de recall de mensagens (ArrowUp/ArrowDown com o cursor no início/fim do texto — ver `key`
  // abaixo e `cycleMessageIndex` em mapper.ts, que espelha `cycleMessage` do webview real).
  const [cycle, setCycle] = useState<CycleState>({ index: -1, saved: '' });
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Trocou de sessão: sai de um ciclo em andamento (o histórico agora é de outra conversa).
  useEffect(() => { setCycle({ index: -1, saved: '' }); }, [sessionId]);
  // Rascunho ficou vazio (enviado, apagado à mão, ou o próprio ciclo restaurou ''): sai do ciclo —
  // mesmo guard do hook real (`Cq0`: "if (currentInput === '') resetHistory()").
  useEffect(() => { if (text === '') setCycle({ index: -1, saved: '' }); }, [text]);

  // Libera as URLs de objeto ao desmontar (as de cada remoção são liberadas em removeAttachment).
  useEffect(() => () => { attachments.forEach(a => a.url && URL.revokeObjectURL(a.url)); }, [attachments]);

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
    const t = text.trim();
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
  function key(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); return; }
    // Recall de mensagens: só quando não há menu aberto (evita brigar com a navegação de um popover)
    // e o cursor está colado no início (ArrowUp) ou no fim (ArrowDown) de TODO o texto — não só da
    // linha atual. É a mesma checagem de posição do cursor da extensão real (`cycleMessage`/`Cq0` no
    // webview decompilado): com texto de várias linhas, ArrowUp no meio continua navegando normal.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !menu && history && history.length && ta.current) {
      const el = ta.current;
      const dir: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd = el.selectionStart === text.length && el.selectionEnd === text.length;
      if ((dir === -1 && atStart) || (dir === 1 && atEnd)) {
        const r = cycleMessageIndex(dir, cycle, history, text);
        if (r) {
          e.preventDefault();
          setCycle({ index: r.index, saved: r.saved });
          setText(r.text);
          // Cursor no início quando ArrowUp mostrou um item do histórico; no fim nos outros casos
          // (espelha N75/O75 do webview real: recall mais antigo começa lido do topo, o resto do fim).
          const pos = dir === -1 && r.index !== -1 ? 0 : r.text.length;
          setTimeout(() => el.setSelectionRange(pos, pos), 0);
        }
      }
    }
  }
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  }
  function onDrop(e: DragEvent<HTMLDivElement>) { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer?.files); }
  function pickSlash(cmd: string) { setText(cmd + ' '); setMenu(''); ta.current?.focus(); }

  // Esc foca/desfoca o compositor.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (menu) { setMenu(''); return; }
      if (document.activeElement === ta.current) ta.current?.blur();
      else ta.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const slashOpen = menu === 'slash' || (menu === '' && /^\/\S*$/.test(text.trimStart()) && text.trim().length > 0);
  const slashFilter = text.trimStart();
  // Lista real da sessão (Query.supportedCommands(), via ClaudePage) quando já existe; senão os 4 fixos.
  const slashSource = commands && commands.length ? commands.map(c => ({ cmd: '/' + c.name, desc: c.description })) : SLASH_FALLBACK;
  const slashItems = slashSource.filter(s => menu === 'slash' || s.cmd.startsWith(slashFilter));
  // Validação ao vivo do nome de worktree (ver mapper.ts) — só roda com algo digitado, igual à
  // extensão real (`let U=G?fF0(G):null`): campo vazio nunca mostra "obrigatório" sozinho, porque
  // aqui (diferente da extensão) vazio é um valor válido — "sem worktree, sessão normal".
  const worktreeNameError = worktreeName ? validateWorktreeName(worktreeName) : null;
  const canSend = !sending && (!!text.trim() || attachments.length > 0) && !worktreeNameError;

  return (
    <div className={`cc-composer ${dragOver ? 'is-dragover' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
      onDrop={onDrop}>
      <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
      {attachments.length > 0 && (
        <div className="cc-attach-row">
          {attachments.map(a => (
            <div key={a.id} className={`cc-attach ${a.isImage ? 'is-image' : ''}`} title={a.name}>
              {a.isImage && a.url
                ? <button type="button" className="cc-attach-thumb-btn" onClick={() => setPreview({ src: a.url!, alt: a.name })} title="Ampliar imagem">
                    <img className="cc-attach-thumb" src={a.url} alt={a.name} />
                  </button>
                : <span className="cc-attach-ico">{a.isImage ? <Image size={13} /> : <File size={13} />}</span>}
              <span className="cc-attach-name">{a.name}</span>
              <button className="cc-attach-x" onClick={() => removeAttachment(a.id)} title="Remover anexo"><X size={10} /></button>
            </div>
          ))}
        </div>
      )}
      <Lightbox image={preview} onClose={() => setPreview(null)} />
      <textarea ref={ta} value={text} onChange={e => setText(e.target.value)} onKeyDown={key} onPaste={onPaste} rows={2}
        placeholder={dragOver ? 'Solte os arquivos aqui…' : running ? 'Claude está trabalhando… você pode enfileirar a próxima mensagem' : 'Escreva para o Claude. Enter envia, Shift+Enter quebra linha, Esc foca/desfoca'} />
      <div className="cc-composer-foot">
        <button className="cc-icon" title="Anexar arquivos ou imagens" onClick={() => fileInput.current?.click()}><Plus /></button>
        <div className="cc-pop">
          <button className="cc-icon" title="Comandos de barra" onClick={() => setMenu(m => m === 'slash' ? '' : 'slash')}><Slash /></button>
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
        {elapsed && <span className="cc-pill cc-pill-ghost"><Clock size={12} /> {elapsed}</span>}
        {projects && onProject && (
          <select className="cc-pill cc-select" value={projectId ?? ''} onChange={e => onProject(Number(e.target.value))} title="Projeto da nova sessão">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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
        {projects && onProject && onWorktreeName && (
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
        {onModel ? (
          <div className="cc-pop">
            <button className="cc-pill cc-pill-ghost" onClick={() => setMenu(m => m === 'model' ? '' : 'model')} title="Modelo">
              {modelLabel} <Chevron size={10} className="cc-chev-down" />
            </button>
            <Menu open={menu === 'model'} onClose={() => setMenu('')} className="cc-menu-up">
              <div className="cc-menu-title">Modelo</div>
              {MODEL_ORDER.map(m => (
                <button key={m} className={`cc-menu-item ${m === (model ?? 'default') ? 'is-active' : ''}`} role="menuitem" onClick={() => { onModel(m); setMenu(''); }}>
                  <span className="cc-menu-item-name">{MODEL_LABEL[m]}</span>
                </button>
              ))}
            </Menu>
          </div>
        ) : (
          <span className="cc-pill" title="Modelo da sessão">{modelLabel}</span>
        )}
        {onEffort && (
          <div className="cc-pop">
            <button className="cc-pill cc-pill-ghost" onClick={() => setMenu(m => m === 'effort' ? '' : 'effort')} title="Esforço de raciocínio">
              <Bolt size={12} /> {EFFORT_LABEL[effort ?? 'medium']} <Chevron size={10} className="cc-chev-down" />
            </button>
            <Menu open={menu === 'effort'} onClose={() => setMenu('')} className="cc-menu-up">
              <div className="cc-menu-title">Esforço</div>
              {EFFORT_ORDER.map(ef => (
                <button key={ef} className={`cc-menu-item ${ef === effort ? 'is-active' : ''}`} role="menuitem" onClick={() => { onEffort(ef); setMenu(''); }}>
                  <span className="cc-menu-item-name">{EFFORT_LABEL[ef]}</span>
                </button>
              ))}
            </Menu>
          </div>
        )}
        <span className="cc-spacer" />
        <div className="cc-pop">
          <button className="cc-pill cc-pill-ghost" onClick={() => setMenu(m => m === 'mode' ? '' : 'mode')} title="Modo de permissão">
            <Bolt size={12} /> {MODE_LABEL[mode]} <Chevron size={10} className="cc-chev-down" />
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
        {running && onStop
          ? <button className="cc-send cc-stop" onClick={onStop} title="Parar"><span className="cc-stop-square" /></button>
          : <button className="cc-send" onClick={() => void send()} disabled={!canSend} title="Enviar"><ArrowUp /></button>}
      </div>
    </div>
  );
}
