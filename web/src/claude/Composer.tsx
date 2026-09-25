import { useState, type KeyboardEvent } from 'react';
import { ArrowUp, Bolt, Clock, Plus, Slash, Chevron } from './icons';

export default function Composer({ onSend, busy, model = 'Fable 5.1', effort = 'Extra high', mode = 'Auto', elapsed = '58m' }:
  { onSend: (text: string) => void; busy?: boolean; model?: string; effort?: string; mode?: string; elapsed?: string }) {
  const [text, setText] = useState('');
  function send() {
    const t = text.trim();
    if (!t) return;
    onSend(t); setText('');
  }
  function key(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }
  return (
    <div className="cc-composer">
      <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={key} rows={2}
        placeholder="⌘ Esc para focar ou desfocar o Claude" />
      <div className="cc-composer-foot">
        <button className="cc-icon" title="Anexar"><Plus /></button>
        <button className="cc-icon" title="Comandos"><Slash /></button>
        <span className="cc-pill cc-pill-ghost"><Clock size={12} /> {elapsed}</span>
        <button className="cc-pill">{model} <span className="cc-pill-effort">{effort}</span></button>
        <span className="cc-spacer" />
        <button className="cc-pill cc-pill-ghost"><Bolt size={12} /> {mode} <Chevron size={10} className="cc-chev-down" /></button>
        <button className="cc-send" onClick={send} disabled={busy || !text.trim()} title="Enviar"><ArrowUp /></button>
      </div>
    </div>
  );
}
