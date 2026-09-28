import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from './types';
import { applyLive, emptyLive, fromRows, toConvEvents, type LiveState } from './live';
import { claudeApi, matchModelAlias, MODEL_LABEL, type ApiSession, type Mode, type Effort, type ModelAlias, type Project } from './api';
import { formatCost, computeUsageBars, messageHistory, type UsageBar } from './mapper';
import Sidebar from './Sidebar';
import Timeline from './Timeline';
import Composer from './Composer';
import { X, Dots, Power, Sync } from './icons';
import './claude.css';

type Tab = { id: string; draft?: boolean; projectId?: number };
const isDraft = (id: string) => id.startsWith('draft-');

function toSummary(s: ApiSession): SessionSummary {
  const status = s.status === 'error' ? 'failed' : s.status;
  return { id: s.id, title: s.title, status, updatedAt: new Date(s.updated_at).getTime(), project: s.project_slug ?? undefined, projectName: s.project_name ?? undefined, archived: !!s.archived };
}

export default function ClaudePage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [login, setLogin] = useState<{ logged_in: boolean; linux_user: string | null; version: string } | null>(null);
  const [usage, setUsage] = useState<UsageBar[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [mode, setMode] = useState<Mode>('acceptEdits');
  const [effort, setEffort] = useState<Effort>('medium');
  const [model, setModel] = useState<ModelAlias>('default');
  const [draftProject, setDraftProject] = useState<number | undefined>(undefined);
  const [erro, setErro] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftCounter = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const restoredRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    try { const r = await claudeApi.sessions(); setSessions(r.sessions); } catch (e: any) { setErro(e.message); }
  }, []);
  const refreshUsage = useCallback(async () => {
    try {
      const r = await claudeApi.usage();
      setUsage(computeUsageBars(r.usage, r.real));
    } catch { /* silencioso */ }
  }, []);

  useEffect(() => {
    let alive = true;
    // Primeira carga: junto com as sessões, restaura as abas que o usuário tinha abertas.
    Promise.allSettled([claudeApi.sessions(), claudeApi.uiState()]).then(([sessRes, uiRes]) => {
      if (!alive) return;
      if (sessRes.status === 'fulfilled') {
        setSessions(sessRes.value.sessions);
        if (uiRes.status === 'fulfilled') {
          const validIds = new Set(sessRes.value.sessions.map(s => s.id));
          setTabs(uiRes.value.tabs.filter(id => validIds.has(id)).map(id => ({ id })));
          setActiveId(uiRes.value.active_id && validIds.has(uiRes.value.active_id) ? uiRes.value.active_id : null);
        }
      } else {
        setErro((sessRes.reason as Error).message);
      }
      restoredRef.current = true;
    });
    void refreshUsage();
    claudeApi.projects().then(r => { setProjects(r.projects); setDraftProject(p => p ?? r.projects[0]?.id); }).catch(e => setErro(e.message));
    claudeApi.status().then(setLogin).catch(() => setLogin(null));
    claudeApi.me().then(r => setEmail(r.user.email)).catch(() => setEmail(null));
    const t = setInterval(() => { void refreshSessions(); void refreshUsage(); }, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [refreshSessions, refreshUsage]);

  // Sempre que as abas abertas mudam, lembra por usuário (sobrevive a reload/troca de dispositivo).
  useEffect(() => {
    if (!restoredRef.current) return;
    const ids = tabs.filter(t => !t.draft).map(t => t.id);
    const active = activeId && !isDraft(activeId) ? activeId : null;
    void claudeApi.saveUiState({ tabs: ids, active_id: active }).catch(() => { /* melhor esforço */ });
  }, [tabs, activeId]);

  // Abre a sessão ativa: carrega histórico e liga o stream.
  useEffect(() => {
    esRef.current?.close(); esRef.current = null;
    if (!activeId || isDraft(activeId)) return;
    let alive = true;
    claudeApi.get(activeId).then(r => {
      if (!alive) return;
      setLive(l => ({ ...l, [activeId]: fromRows(r.events, r.session.status, r.pending) }));
      const es = new EventSource(`/api/claude/sessions/${activeId}/stream`);
      es.onmessage = (m) => { try { const ev = JSON.parse(m.data); setLive(l => ({ ...l, [activeId]: applyLive(l[activeId] ?? emptyLive(), ev) })); if (ev.type === 'turn_end' || ev.type === 'status') void refreshSessions(); if (ev.type === 'turn_end') void refreshUsage(); } catch { /* ignora */ } };
      es.onerror = () => { /* o navegador reconecta sozinho */ };
      esRef.current = es;
      const s = r.session; if (s.permission_mode && ['acceptEdits', 'default', 'plan', 'auto'].includes(s.permission_mode)) setMode(s.permission_mode as Mode);
      setModel(matchModelAlias(s.model));
    }).catch(e => setErro(e.message));
    return () => { alive = false; esRef.current?.close(); esRef.current = null; };
  }, [activeId, refreshSessions, refreshUsage]);

  const state = activeId ? (live[activeId] ?? emptyLive()) : emptyLive();
  const events = useMemo(() => toConvEvents(state), [state]);
  // Recall ArrowUp/ArrowDown do compositor: mensagens já enviadas nesta sessão, mais recente primeiro.
  const history = useMemo(() => messageHistory(events), [events]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [events.length, state.partialText.length, state.partialThinking.length, activeId]);

  const active = sessions.find(s => s.id === activeId);
  const activeTab = tabs.find(t => t.id === activeId);
  const running = state.status === 'running' || state.status === 'waiting';

  function open(id: string) {
    setActiveId(id);
    setTabs(t => t.some(x => x.id === id) ? t : [...t, { id }]);
  }
  function closeTab(id: string) {
    setTabs(t => { const next = t.filter(x => x.id !== id); if (id === activeId) setActiveId(next.length ? next[next.length - 1].id : null); return next; });
  }
  function newSession() {
    const id = `draft-${++draftCounter.current}`;
    setTabs(t => [...t, { id, draft: true, projectId: draftProject }]);
    setActiveId(id);
  }
  async function send(text: string, files: File[] = []) {
    setErro('');
    try {
      const prompt = text || (files.length ? '(arquivos em anexo)' : '');
      const attachments = files.length ? (await claudeApi.uploads(files)).attachments : undefined;
      // 'default' = sem override (deixa a sessão/conta decidir); só manda um valor real quando o
      // usuário escolheu algo no seletor de modelo.
      const modelOverride = model !== 'default' ? model : undefined;
      if (!activeId || isDraft(activeId)) {
        const pid = activeTab?.projectId ?? draftProject ?? projects[0]?.id;
        if (!pid) { setErro('Nenhum projeto cadastrado'); return; }
        const r = await claudeApi.create({ project_id: pid, prompt, permission_mode: mode, model: modelOverride, effort, attachments });
        const draftId = activeId;
        setTabs(t => draftId ? t.map(x => x.id === draftId ? { id: r.id } : x) : [...t, { id: r.id }]);
        setActiveId(r.id);
        void refreshSessions();
      } else {
        await claudeApi.send(activeId, { prompt, permission_mode: mode, model: modelOverride, effort, attachments });
      }
    } catch (e: any) { setErro(e.message); throw e; }
  }
  async function decide(approvalId: string, d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) {
    if (!activeId) return;
    try { await claudeApi.permission(activeId, { approval_id: approvalId, decision: d, message: msg }); } catch (e: any) { setErro(e.message); }
  }
  async function stop() { if (activeId && !isDraft(activeId)) { try { await claudeApi.stop(activeId); } catch (e: any) { setErro(e.message); } } }
  async function rename() {
    if (!active) return;
    const t = window.prompt('Novo título da sessão', active.title);
    if (t && t.trim()) { await claudeApi.rename(active.id, t.trim()); void refreshSessions(); }
  }
  async function renameSession(id: string, title: string) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, title } : s));
    try { await claudeApi.rename(id, title); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  async function archiveSession(id: string, archived: boolean) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, archived } : s));
    try { await claudeApi.archive(id, archived); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }

  const summaries = useMemo(() => sessions.map(toSummary), [sessions]);
  const title = activeTab?.draft ? 'Nova sessão' : (active?.title ?? (activeId ? 'Sessão' : 'Claude'));
  // Mostra o que vale pra PRÓXIMA mensagem: o override escolhido no seletor, se houver; senão o
  // modelo resolvido da sessão (gravado no system/init do SDK), como antes.
  const modelLabel = model !== 'default' ? MODEL_LABEL[model] : (active?.model ?? 'modelo padrão');

  return (
    <div className="cc">
      <Sidebar sessions={summaries} usage={usage} activeId={activeId} onSelect={open} onNew={newSession} onRename={renameSession} onArchive={archiveSession} />
      <main className="cc-main">
        <div className="cc-tabs">
          {tabs.map(t => {
            const s = sessions.find(x => x.id === t.id);
            const label = t.draft ? 'Nova sessão' : (s?.title ?? '…');
            return (
              <div key={t.id} className={`cc-tab ${t.id === activeId ? 'is-active' : ''}`} onClick={() => setActiveId(t.id)}>
                <span className="cc-tab-spark">✳</span><span className="cc-tab-title">{label}</span>
                <button className="cc-tab-x" onClick={e => { e.stopPropagation(); closeTab(t.id); }} title="Fechar aba"><X size={11} /></button>
              </div>
            );
          })}
          <span className="cc-spacer" />
          <span className="cc-tab-actions">
            <button className="cc-icon" title="Parar sessão" onClick={stop}><Power size={13} /></button>
            <button className="cc-icon" title="Recarregar lista" onClick={() => { void refreshSessions(); void refreshUsage(); }}><Sync size={13} /></button>
            <button className="cc-icon" title="Renomear sessão" onClick={rename}><Dots size={13} /></button>
          </span>
        </div>
        {login && !login.logged_in && (
          <div className="cc-banner">
            O Claude não está logado na c3 como <span className="cc-mono">{login.linux_user ?? 'danilo'}</span>. Cole o token do Max em <b>Configurações</b>, ou no seu Mac: <span className="cc-mono">ssh c3</span> e depois <span className="cc-mono">sudo -iu danilo claude</span>.
          </div>
        )}
        <div className="cc-head">
          <span>{title}</span>
          {active && <span className="cc-head-meta">{active.project_name ?? ''} · {active.user_name} · {formatCost(Number(active.cost_usd))} · {active.turns} turnos · <span className={`cc-dot is-${toSummary(active).status}`} /> {active.status}</span>}
        </div>
        {erro && <div className="cc-error-bar">{erro}</div>}
        <div className="cc-scroll" ref={scrollRef}>
          {!activeId && (
            <div className="cc-empty-state">
              <div className="cc-brand-big">✳ Claude Code</div>
              <p>Escolha uma sessão à esquerda ou clique em <b>Nova sessão</b>.</p>
              <p className="cc-muted">Cada sessão roda na c3, na pasta do projeto, com o login único do Max. Fechar o navegador não interrompe nada.</p>
            </div>
          )}
          {activeId && <Timeline events={events} onDecide={decide} />}
        </div>
        {activeId && (
          <Composer onSend={send} onStop={stop} running={running} mode={mode} onMode={setMode} effort={effort} onEffort={setEffort}
            model={model} onModel={setModel} modelLabel={modelLabel} history={history} commands={state.commands} sessionId={activeId}
            projects={activeTab?.draft ? projects : undefined} projectId={activeTab?.projectId ?? draftProject}
            onProject={(id) => { setDraftProject(id); setTabs(t => t.map(x => x.id === activeId ? { ...x, projectId: id } : x)); }} />
        )}
        <div className="cc-status">
          <span>{active?.project_slug ?? '—'}</span><span className="cc-mono">{active?.cwd ?? ''}</span><span className="cc-spacer" />
          <span>{login ? `Claude Code ${login.version}` : ''}</span><span>{sessions.filter(s => s.status === 'running' || s.status === 'waiting').length} ativa(s)</span>
        </div>
      </main>
    </div>
  );
}
