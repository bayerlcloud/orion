import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from './api';

/**
 * Painel lateral direito "Orion": chat com o agente do sistema, uma sessão contínua por colaborador.
 * Por enquanto só a UI (pedido do Danilo, 03/10/2026); o motor entra depois. As mensagens vivem só
 * na memória da página.
 */
// ponytail: sem motor ainda; ligar a POST /api/orion-chat quando o agente existir.

type Msg = { from: 'me' | 'orion'; text: string };

const KEY = 'orion:painel-direito';
// Evento global de alternar: o botão do canto (App.tsx, todas as páginas) e o botão dentro da barra
// de abas do Claude (ClaudePage.tsx — pedido do Danilo, 04/10/2026: trocar os dois de lugar, ⋮ pro
// canto e este botão pra dentro da barra) chamam `useOrionPanel()` cada um na sua própria instância;
// sem esse evento, cada instância teria seu próprio `open` e um botão não saberia que o outro mudou.
const EVENTO = 'orion:painel-direito-toggle';

export function IcoPainelDireito({ open }: { open: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      {open && <path d="M15 4h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3z" fill="currentColor" stroke="none" />}
      <path d="M15 4v16" />
    </svg>
  );
}

export function useOrionPanel() {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) === '1');
  useEffect(() => { localStorage.setItem(KEY, open ? '1' : '0'); }, [open]);
  useEffect(() => {
    const h = () => setOpen(o => !o);
    window.addEventListener(EVENTO, h);
    return () => window.removeEventListener(EVENTO, h);
  }, []);
  const toggle = useCallback(() => window.dispatchEvent(new Event(EVENTO)), []);
  return [open, toggle] as const;
}

export function OrionPanel({ user }: { user: User }) {
  const nome = (user.name || user.email).split(' ')[0];
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: 'orion', text: `Oi, ${nome}. Eu sou o Orion. Posso tirar dúvidas sobre o sistema, agendar tarefas e falar com o Claude por você.` },
  ]);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  function send() {
    const t = text.trim();
    if (!t) return;
    setText('');
    setMsgs(m => [...m, { from: 'me', text: t }, { from: 'orion', text: 'Ainda estou sem motor: por enquanto só a tela existe.' }]);
  }

  return (
    <aside className="orion-panel">
      <header className="orion-panel-head">Orion</header>
      <div className="orion-panel-msgs">
        {msgs.map((m, i) => <div key={i} className={`orion-msg is-${m.from}`}>{m.text}</div>)}
        <div ref={endRef} />
      </div>
      <div className="orion-panel-input">
        <textarea rows={2} placeholder="Pergunte ao Orion…" value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      </div>
    </aside>
  );
}
