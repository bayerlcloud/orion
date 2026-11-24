import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { User } from './api';
import { claudeApi } from './claude/api';
import { applyLive, emptyLive, fromRows, toConvEvents, type LiveState } from './claude/live';
import { getOpenFile, subscribeOpenFile } from './openFile';

const SESSAO_KEY = 'orion:painel-direito-sessao';

/**
 * Corpo do painel lateral "Orion" (copilot com sessão Claude real). Em arquivo à parte de
 * OrionPanel.tsx e carregado por lazy() no App.tsx: puxa claude/api.ts e claude/live.ts, que não
 * precisam entrar no bundle inicial (tela de login não usa nada disso).
 */
export default function OrionPanelBody({ user }: { user: User }) {
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

  // Celular/aba em segundo plano por muito tempo: a conexão costuma estar morta ao voltar (mesmo
  // padrão de ClaudePage.tsx). Reabre se caiu ou se a aba ficou escondida mais de 30s.
  const [revive, setRevive] = useState(0);
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      const es = esRef.current;
      if ((es && es.readyState === EventSource.CLOSED) || (hiddenAt && Date.now() - hiddenAt > 30_000)) setRevive(n => n + 1);
      hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Liga o stream da sessão contínua: ao montar (sessão já existe de uma visita anterior), a cada
  // troca de id (sessão nova criada pelo primeiro envio) e ao reviver. Mesmo padrão de ClaudePage.tsx:
  // buffer enquanto carrega o histórico, pra não perder eventos que cheguem nesse meio-tempo.
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
  }, [sessionId, revive]);

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
