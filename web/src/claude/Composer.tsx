import { useState, type KeyboardEvent } from 'react';
import { ArrowUp, Bolt, Clock, Plus, Slash, Chevron } from './icons';
import { MODE_LABEL, MODE_ORDER, type Mode, type Project } from './api';

export default function Composer({ onSend, onStop, running, mode, onMode, modelLabel, projects, projectId, onProject, elapsed }: {
  onSend: (text: string) => void; onStop?: () => void; running: boolean; mode: Mode; onMode: (m: Mode) => void; modelLabel: string;
  projects?: Project[]; projectId?: number; onProject?: (id: number) => void; elapsed?: string;
}) {
  const [text, setText] = useState('');
  function send() { const t = text.trim(); if (!t) return; onSend(t); setText(''); }
  function key(e: KeyboardEvent<HTMLTextAreaElement>) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
  function cycleMode() { const i = MODE_ORDER.indexOf(mode); onMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]); }
  return (
    <div className="cc-composer">
      <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={key} rows={2}
        placeholder={running ? 'Claude está trabalhando… você pode enfileirar a próxima mensagem' : 'Escreva para o Claude. Enter envia, Shift+Enter quebra linha'} />
      <div className="cc-composer-foot">
        <button className="cc-icon" title="Anexar (em breve)"><Plus /></button>
        <button className="cc-icon" title="Comandos (em breve)"><Slash /></button>
        {elapsed && <span className="cc-pill cc-pill-ghost"><Clock size={12} /> {elapsed}</span>}
        {projects && onProject && (
          <select className="cc-pill cc-select" value={projectId ?? ''} onChange={e => onProject(Number(e.target.value))} title="Projeto da nova sessão">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span className="cc-pill" title="Modelo da sessão">{modelLabel}</span>
        <span className="cc-spacer" />
        <button className="cc-pill cc-pill-ghost" onClick={cycleMode} title="Clique para trocar o modo de permissão"><Bolt size={12} /> {MODE_LABEL[mode]} <Chevron size={10} className="cc-chev-down" /></button>
        {running && onStop
          ? <button className="cc-send cc-stop" onClick={onStop} title="Parar"><span className="cc-stop-square" /></button>
          : <button className="cc-send" onClick={send} disabled={!text.trim()} title="Enviar"><ArrowUp /></button>}
      </div>
    </div>
  );
}
