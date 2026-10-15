import { useEffect, useRef, useState } from 'react';
import { api, type User } from '../api';
import { IcoChat } from '../icons';

type Conversa = { channel: string; nome: string; unread: number };
type Mensagem = { id: number; from_user_id: number; from_name: string; text: string; created_at: string };

const KEY = 'orion:chat-aberto';
const CANAL_KEY = 'orion:chat-canal';

/**
 * Chat entre pessoas do painel: botão flutuante no canto inferior direito (independente do painel
 * Orion, que fica no canto superior), lista de conversas (equipe + uma por pessoa) e mensagens.
 * Sem WebSocket de propósito: só 4 pessoas no time, polling a cada poucos segundos resolve sem
 * subir infra nova — se o time crescer muito ou quiser "digitando…" ao vivo, troca por SSE.
 */
export function ChatDrawer({ user }: { user: User }) {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) === '1');
  const [conversas, setConversas] = useState<Conversa[]>([]);
  const [canal, setCanal] = useState<string | null>(() => localStorage.getItem(CANAL_KEY));
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { localStorage.setItem(KEY, open ? '1' : '0'); }, [open]);
  useEffect(() => { if (canal) localStorage.setItem(CANAL_KEY, canal); }, [canal]);

  // Lista de conversas com badge de não lida: sempre viva (mesmo com o chat fechado), pra o botão
  // flutuante mostrar que chegou mensagem nova.
  useEffect(() => {
    let alive = true;
    const carregar = () => api<{ conversas: Conversa[] }>('/api/chat/conversas').then((r) => { if (alive) setConversas(r.conversas); }).catch(() => {});
    carregar();
    const t = setInterval(carregar, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Mensagens do canal aberto, só enquanto o chat está aberto.
  useEffect(() => {
    if (!open || !canal) return;
    let alive = true;
    const carregar = () => api<{ mensagens: Mensagem[] }>(`/api/chat/${encodeURIComponent(canal)}/mensagens`)
      .then((r) => { if (alive) setMensagens(r.mensagens); })
      .catch(() => {});
    carregar();
    api(`/api/chat/${encodeURIComponent(canal)}/lida`, { method: 'POST' }).catch(() => {});
    const t = setInterval(carregar, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [open, canal]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [mensagens.length]);

  const unreadTotal = conversas.reduce((s, c) => s + c.unread, 0);

  async function enviar() {
    const t = text.trim();
    if (!t || !canal) return;
    setText('');
    const { mensagem } = await api<{ mensagem: Mensagem }>(`/api/chat/${encodeURIComponent(canal)}/mensagens`, {
      method: 'POST', body: JSON.stringify({ text: t }),
    });
    setMensagens((ms) => [...ms, mensagem]);
  }

  const conversaAtual = conversas.find((c) => c.channel === canal);

  return (
    <>
      <button className="chat-toggle" onClick={() => setOpen((o) => !o)} title="Chat da equipe" aria-label="Chat da equipe">
        <IcoChat />
        {unreadTotal > 0 && <span className="chat-badge">{unreadTotal > 9 ? '9+' : unreadTotal}</span>}
      </button>
      {open && (
        <aside className="chat-panel">
          <header className="chat-panel-head">
            {canal && <button className="chat-voltar" onClick={() => setCanal(null)} aria-label="Voltar">‹</button>}
            <span>{canal ? conversaAtual?.nome ?? '' : 'Chat'}</span>
            <button className="chat-fechar" onClick={() => setOpen(false)} aria-label="Fechar">×</button>
          </header>
          {!canal ? (
            <div className="chat-lista">
              {conversas.map((c) => (
                <button key={c.channel} className="chat-conversa" onClick={() => setCanal(c.channel)}>
                  <span>{c.nome}</span>
                  {c.unread > 0 && <span className="chat-badge">{c.unread > 9 ? '9+' : c.unread}</span>}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="chat-msgs">
                {mensagens.map((m) => (
                  <div key={m.id} className={`chat-msg ${m.from_user_id === user.id ? 'is-me' : ''}`}>
                    {m.from_user_id !== user.id && canal === 'equipe' && <div className="chat-msg-autor">{m.from_name}</div>}
                    <div className="chat-msg-bolha">{m.text}</div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div className="chat-input">
                <textarea rows={1} placeholder="Escreva uma mensagem…" value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void enviar(); } }} />
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}
