import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Bolt, Clock, Plus, Slash, Chevron } from './icons';
import { MODE_LABEL, MODE_DESC, MODE_ORDER, EFFORT_LABEL, EFFORT_ORDER, type Mode, type Effort, type Project } from './api';

/** Comandos de barra que passam direto pro Claude Code (sem execução no nosso servidor). */
const SLASH: { cmd: string; desc: string }[] = [
  { cmd: '/clear', desc: 'Limpa o contexto da conversa' },
  { cmd: '/compact', desc: 'Resume o histórico para liberar contexto' },
  { cmd: '/context', desc: 'Mostra o uso da janela de contexto' },
  { cmd: '/cost', desc: 'Mostra custo e tokens da sessão' },
];

function Menu({ open, onClose, children, className = '' }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  if (!open) return null;
  return (
    <>
      <div className="cc-menu-backdrop" onClick={onClose} />
      <div className={`cc-menu ${className}`} role="menu">{children}</div>
    </>
  );
}

export default function Composer({ onSend, onStop, running, mode, onMode, effort, onEffort, modelLabel, projects, projectId, onProject, elapsed }: {
  onSend: (text: string) => void; onStop?: () => void; running: boolean; mode: Mode; onMode: (m: Mode) => void;
  effort?: Effort; onEffort?: (e: Effort) => void; modelLabel: string;
  projects?: Project[]; projectId?: number; onProject?: (id: number) => void; elapsed?: string;
}) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<'' | 'mode' | 'effort' | 'slash'>('');
  const ta = useRef<HTMLTextAreaElement>(null);

  function send() { const t = text.trim(); if (!t) return; onSend(t); setText(''); }
  function key(e: KeyboardEvent<HTMLTextAreaElement>) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
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
  const slashItems = SLASH.filter(s => menu === 'slash' || s.cmd.startsWith(slashFilter));

  return (
    <div className="cc-composer">
      <textarea ref={ta} value={text} onChange={e => setText(e.target.value)} onKeyDown={key} rows={2}
        placeholder={running ? 'Claude está trabalhando… você pode enfileirar a próxima mensagem' : 'Escreva para o Claude. Enter envia, Shift+Enter quebra linha, Esc foca/desfoca'} />
      <div className="cc-composer-foot">
        <button className="cc-icon" title="Anexar (em breve)"><Plus /></button>
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
        {elapsed && <span className="cc-pill cc-pill-ghost"><Clock size={12} /> {elapsed}</span>}
        {projects && onProject && (
          <select className="cc-pill cc-select" value={projectId ?? ''} onChange={e => onProject(Number(e.target.value))} title="Projeto da nova sessão">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span className="cc-pill" title="Modelo da sessão">{modelLabel}</span>
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
          : <button className="cc-send" onClick={send} disabled={!text.trim()} title="Enviar"><ArrowUp /></button>}
      </div>
    </div>
  );
}
