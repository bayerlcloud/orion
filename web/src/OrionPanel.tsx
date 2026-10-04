import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { User } from './api';
import { claudeApi } from './claude/api';
import { applyLive, emptyLive, fromRows, toConvEvents, type LiveState } from './claude/live';
import { getOpenFile, subscribeOpenFile } from './openFile';

/**
 * Painel lateral direito "Orion": copilot com sessão Claude real (Agent SDK, tools Edit/Write
 * inclusas). Uma sessão contínua por colaborador, guardada no localStorage — se a pessoa tem um
 * arquivo aberto na aba Arquivos (ver openFile.ts), ele vai como contexto no início da mensagem e a
 * sessão nasce no projeto desse arquivo (mesma worktree por usuário de qualquer sessão do /claude).
 * Sem seletor de modo/modelo aqui de propósito: isso já existe em detalhe na página /claude; este
 * painel é o atalho rápido, sempre em modo "aceita edição" (pedido do Danilo, 04/10/2026).
 */
const KEY = 'orion:painel-direito';
const SESSAO_KEY = 'orion:painel-direito-sessao';
// Evento global de alternar: o botão do canto (App.tsx, todas as páginas) e o botão dentro da barra
// de abas do Claude (ClaudePage.tsx — pedido do Danilo, 04/10/2026: trocar os dois de lugar, ⋮ pro
// canto e este botão pra dentro da barra) chamam `useOrionPanel()` cada um na sua própria instância;
// sem esse evento, cada instância teria seu próprio `open` e um botão não saberia que o outro mudou.
const EVENTO = 'orion:painel-direito-toggle';

export function IcoPainelDireito({ open, size = 18 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
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
  const openFile = useSyncExternalStore(subscribeOpenFile, getOpenFile);
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSAO_KEY));
  const [live, setLive] = useState<LiveState>(emptyLive());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const events = toConvEvents(live);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [events.length, live.partialText]);

  // Liga o stream da sessão contínua: ao montar (sessão já existe de uma visita anterior) e a cada
  // troca de id (sessão nova criada pelo primeiro envio). Mesmo padrão de ClaudePage.tsx: buffer
  // enquanto carrega o histórico, pra não perder eventos que cheguem nesse meio-tempo.
  useEffect(() => {
    esRef.current?.close(); esRef.current = null;
    if (!sessionId) return;
    let alive = true;
    let buffer: any[] | null = [];
    const es = new EventSource(`/api/claude/sessions/${sessionId}/stream`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (buffer) { buffer.push(ev); return; }
        setLive(l => applyLive(l, ev));
      } catch { /* ignora */ }
    };
    es.onopen = () => {
      buffer = buffer ?? [];
      claudeApi.get(sessionId).then(r => {
        if (!alive) return;
        const pending = buffer ?? []; buffer = null;
        setLive(pending.reduce((st, ev) => applyLive(st, ev), fromRows(r.events, r.session.status, r.pending)));
      }).catch(() => { buffer = null; });
    };
    esRef.current = es;
    return () => { alive = false; es.close(); };
  }, [sessionId]);

  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setText(''); setErro(null); setSending(true);
    const prompt = openFile ? `[arquivo aberto no editor: ${openFile.rel}]\n\n${t}` : t;
    try {
      if (!sessionId) {
        const r = await claudeApi.create({ project_id: openFile?.rootId ?? null, prompt, permission_mode: 'acceptEdits' });
        localStorage.setItem(SESSAO_KEY, r.id);
        setSessionId(r.id);
      } else {
        await claudeApi.send(sessionId, { prompt, permission_mode: 'acceptEdits' });
      }
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="orion-panel">
      <header className="orion-panel-head">Orion</header>
      <div className="orion-panel-msgs">
        {!events.length && !live.messages.length && (
          <div className="orion-msg is-orion">Oi, {nome}. Eu sou o Orion. Posso tirar dúvidas, editar o arquivo que você tiver aberto na aba Arquivos, ou falar com o Claude por você.</div>
        )}
        {events.map(e => {
          if (e.kind === 'user') return <div key={e.id} className="orion-msg is-me">{e.text}</div>;
          if (e.kind === 'text') return <div key={e.id} className="orion-msg is-orion">{e.text}</div>;
          if (e.kind === 'tool') return <div key={e.id} className="orion-msg is-tool">{e.label}</div>;
          if (e.kind === 'busy') return <div key={e.id} className="orion-msg is-tool">pensando…</div>;
          if (e.kind === 'result' && !e.ok) return <div key={e.id} className="orion-msg is-erro">{e.error ?? 'erro'}</div>;
          return null;
        })}
        {erro && <div className="orion-msg is-erro">{erro}</div>}
        <div ref={endRef} />
      </div>
      {openFile && <div className="orion-panel-contexto">arquivo aberto: {openFile.rel}</div>}
      <div className="orion-panel-input">
        <textarea rows={2} placeholder="Pergunte ao Orion…" value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
      </div>
    </aside>
  );
}
