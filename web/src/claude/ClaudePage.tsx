import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConvEvent, SessionSummary } from './types';
import { reduceSdkMessages } from './mapper';
import { CONVERSATIONS, PENDING_PERMISSION, SESSIONS, USAGE } from './fixtures';
import Sidebar from './Sidebar';
import Timeline from './Timeline';
import Composer from './Composer';
import { X, Dots, Power, Sync } from './icons';
import './claude.css';

function initialEvents(id: string): ConvEvent[] {
  const ev = reduceSdkMessages(CONVERSATIONS[id] ?? []);
  if (PENDING_PERMISSION.sessionId === id) {
    ev.push({ id: 'perm-1', kind: 'permission', toolUseId: PENDING_PERMISSION.toolUseId, name: PENDING_PERMISSION.name, label: PENDING_PERMISSION.label, description: PENDING_PERMISSION.description, inputText: PENDING_PERMISSION.inputText });
  }
  return ev;
}

export default function ClaudePage() {
  const [sessions, setSessions] = useState<SessionSummary[]>(SESSIONS);
  const [openTabs, setOpenTabs] = useState<string[]>(['s-forms', 's-dash', 's-v2', 's-fisio']);
  const [activeId, setActiveId] = useState<string>('s-v2');
  const [convs, setConvs] = useState<Record<string, ConvEvent[]>>({});
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const counter = useRef(1000);

  const events = useMemo(() => convs[activeId] ?? initialEvents(activeId), [convs, activeId]);
  const active = sessions.find(s => s.id === activeId);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [events.length, activeId]);

  function setEvents(id: string, fn: (prev: ConvEvent[]) => ConvEvent[]) {
    setConvs(c => ({ ...c, [id]: fn(c[id] ?? initialEvents(id)) }));
  }
  function setStatus(id: string, status: SessionSummary['status']) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, status, updatedAt: Date.now() } : s));
  }
  function select(id: string) {
    setActiveId(id);
    setOpenTabs(t => t.includes(id) ? t : [...t, id]);
    setSessions(ss => ss.map(s => s.id === id && s.status === 'unread' ? { ...s, status: 'idle' } : s));
  }
  function closeTab(id: string) {
    setOpenTabs(t => {
      const next = t.filter(x => x !== id);
      if (id === activeId && next.length) setActiveId(next[next.length - 1]);
      return next;
    });
  }
  function newSession() {
    const id = `s-new-${++counter.current}`;
    setSessions(ss => [{ id, title: 'Nova sessão', status: 'idle', updatedAt: Date.now() }, ...ss]);
    setConvs(c => ({ ...c, [id]: [{ id: 'sys', kind: 'system', text: 'Sessão iniciada · modelo claude-fable-5-1 · pasta /srv/work' }] }));
    select(id);
  }
  function send(text: string) {
    const id = activeId;
    const uid = `u${++counter.current}`, tid = `t${++counter.current}`;
    setEvents(id, ev => [...ev, { id: uid, kind: 'user', text }, { id: tid, kind: 'thinking', text: 'Sessão de exemplo: o motor real, o Agent SDK rodando na worktree da tarefa, entra na Entrega 1.', streaming: true }]);
    setStatus(id, 'running'); setBusy(true);
    setTimeout(() => {
      setEvents(id, ev => [
        ...ev.map(e => e.id === tid ? { ...e, streaming: false } : e),
        { id: `a${++counter.current}`, kind: 'text', text: `Recebi: "${text}". Esta tela ainda é uma demonstração da interface. Quando o motor entrar, esta resposta vem do Claude Code de verdade, com ferramentas, diffs e pedidos de permissão.` },
        { id: `r${++counter.current}`, kind: 'result', ok: true, costUsd: 0, durationMs: 1200, turns: 1 },
      ]);
      setStatus(id, 'idle'); setBusy(false);
    }, 1400);
  }
  function decide(eventId: string, d: 'allow' | 'allow_always' | 'deny', msg?: string) {
    const id = activeId;
    setEvents(id, ev => {
      const next = ev.map(e => e.id === eventId && e.kind === 'permission' ? { ...e, decision: d } : e);
      if (d === 'deny') next.push({ id: `s${++counter.current}`, kind: 'system', text: msg ? `Negado. Instrução: ${msg}` : 'Negado. Claude segue sem executar.' });
      else next.push({ id: `t${++counter.current}`, kind: 'tool', toolUseId: 'd2', name: 'Bash', label: 'Bash', description: 'Restart the Central service', input: {}, inputText: 'systemctl restart orion-central', output: '', status: 'success' },
        { id: `x${++counter.current}`, kind: 'text', text: 'Serviço reiniciado. A Central respondeu em `/api/health` com `{"ok":true}`.' },
        { id: `r${++counter.current}`, kind: 'result', ok: true, costUsd: 0.0187, durationMs: 9_300, turns: 3 });
      return next;
    });
    setStatus(id, 'idle');
  }

  return (
    <div className="cc">
      <Sidebar sessions={sessions} usage={USAGE} activeId={activeId} onSelect={select} onNew={newSession} />
      <main className="cc-main">
        <div className="cc-tabs">
          {openTabs.map(id => {
            const s = sessions.find(x => x.id === id); if (!s) return null;
            return (
              <div key={id} className={`cc-tab ${id === activeId ? 'is-active' : ''}`} onClick={() => setActiveId(id)}>
                <span className="cc-tab-spark">✳</span><span className="cc-tab-title">{s.title}</span>
                <button className="cc-tab-x" onClick={e => { e.stopPropagation(); closeTab(id); }} title="Fechar"><X size={11} /></button>
              </div>
            );
          })}
          <span className="cc-spacer" />
          <span className="cc-tab-actions"><Power size={13} /><Sync size={13} /><Dots size={13} /></span>
        </div>
        <div className="cc-head">{active?.title ?? 'Sessão'}</div>
        <div className="cc-scroll" ref={scrollRef}>
          <Timeline events={events} onDecide={decide} />
        </div>
        <Composer onSend={send} busy={busy} />
        <div className="cc-status">
          <span>{active?.project ?? '—'}</span><span>main+</span><span className="cc-spacer" /><span>Claude Nativo</span><span>Layout: PT-BR</span>
        </div>
      </main>
    </div>
  );
}
