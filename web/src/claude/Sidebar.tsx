import { useState } from 'react';
import type { SessionSummary } from './types';
import type { UsageBar } from './mapper';
import { relativeTime, filterSessions, groupSessions, type GroupBy } from './mapper';
import { Chevron, Plus, Search, Bolt, X, Archive, Pencil } from './icons';

function SessionRow({ s, active, onSelect, onRename, onArchive }: {
  s: SessionSummary; active: boolean; onSelect: () => void;
  onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.title);
  function commit() { const t = draft.trim(); setEditing(false); if (t && t !== s.title) onRename(s.id, t); }
  return (
    <div className={`cc-item ${active ? 'is-active' : ''}`}>
      <span className={`cc-dot is-${s.status}`} />
      {editing ? (
        <input className="cc-item-edit" autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
      ) : (
        <button className="cc-item-name" onClick={onSelect} title={s.title}>{s.title}</button>
      )}
      <span className="cc-item-time">{relativeTime(s.updatedAt)}</span>
      <span className="cc-item-actions">
        <button className="cc-item-act" title="Renomear" onClick={() => { setDraft(s.title); setEditing(true); }}><Pencil size={12} /></button>
        <button className="cc-item-act" title={s.archived ? 'Desarquivar' : 'Arquivar'} onClick={() => onArchive(s.id, !s.archived)}><Archive size={12} /></button>
      </span>
    </div>
  );
}

function SessionGroupSection({ groupKey, label, sessions, collapsible, collapsed, onToggle, activeId, onSelect, onRename, onArchive }: {
  groupKey: string; label: string; sessions: SessionSummary[]; collapsible: boolean; collapsed: boolean; onToggle: () => void;
  activeId: string | null; onSelect: (id: string) => void; onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void;
}) {
  return (
    <div key={groupKey}>
      <div className={`cc-group-head ${collapsible ? 'cc-clickable' : ''}`} onClick={collapsible ? onToggle : undefined}>
        <Chevron size={11} className={`cc-chev ${collapsed ? '' : 'is-open'}`} /> {label} <span className="cc-badge">{sessions.length}</span>
      </div>
      {!collapsed && (
        <div className="cc-list">
          {sessions.map(s => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={() => onSelect(s.id)} onRename={onRename} onArchive={onArchive} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ sessions, usage, activeId, loading, onSelect, onNew, onRename, onArchive }:
  { sessions: SessionSummary[]; usage: UsageBar[]; activeId: string | null; loading?: boolean;
    onSelect: (id: string) => void; onNew: () => void; onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void; }) {
  const [where, setWhere] = useState<'local' | 'web'>('local');
  const [open, setOpen] = useState(true);
  const [acctOpen, setAcctOpen] = useState(true);
  const [q, setQ] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  function toggleGroup(key: string) {
    setCollapsedGroups(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  const isActive = (s: SessionSummary) => s.status === 'running' || s.status === 'waiting';
  const activeCount = sessions.filter(isActive).length;
  const filter = { term: q, project: projectFilter || undefined, activeOnly };
  const localList = where === 'local' ? filterSessions(sessions.filter(s => !s.archived), filter) : [];
  const archivedList = where === 'local' ? filterSessions(sessions.filter(s => s.archived), filter) : [];
  const groups = groupSessions(localList, groupBy);

  // Projetos presentes entre as sessões, para o filtro (slug → rótulo). Só aparece quando há mais de um.
  const projectOptions: [string, string][] = [];
  const seenProjects = new Set<string>();
  for (const s of sessions) {
    if (s.project && !seenProjects.has(s.project)) { seenProjects.add(s.project); projectOptions.push([s.project, s.projectName ?? s.project]); }
  }
  projectOptions.sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));

  return (
    <aside className="cc-side">
      <div className="cc-side-title">CLAUDE CODE</div>

      <section className="cc-section">
        <div className="cc-section-head" onClick={() => setAcctOpen(o => !o)}>
          <Chevron size={12} className={`cc-chev ${acctOpen ? 'is-open' : ''}`} /> CONTA E USO
        </div>
        {acctOpen && (
          <>
            <div className="cc-usage-title">USO</div>
            {usage.map(u => (
              <div key={u.key} className="cc-usage">
                <div className="cc-usage-head"><span>{u.label}</span><span>{u.pct}%</span></div>
                {/* limiar de 80% é o mesmo da extensão real (função `ee` do webview: usageFillHigh a partir de 80%) */}
                <div className="cc-track"><div className={`cc-fill ${u.pct >= 80 ? 'is-high' : ''}`} style={{ width: `${u.pct}%` }} /></div>
                {u.sub && <div className="cc-usage-note">{u.sub}</div>}
                {u.resetText && <div className="cc-usage-note">Reinicia {u.resetText}</div>}
              </div>
            ))}
          </>
        )}
      </section>

      <section className="cc-section cc-sessions">
        <div className="cc-section-head" onClick={() => setOpen(o => !o)}><Chevron size={12} className={`cc-chev ${open ? 'is-open' : ''}`} /> SESSÕES</div>
        {open && (
          <>
            <button className="cc-new" onClick={onNew}><Plus size={13} /> Nova sessão</button>
            <div className="cc-toggle">
              <button className={where === 'local' ? 'is-on' : ''} onClick={() => setWhere('local')}>Local</button>
              <button className={where === 'web' ? 'is-on' : ''} onClick={() => setWhere('web')}>Web</button>
            </div>
            <div className="cc-search">
              <Search size={12} className="cc-search-icon" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar sessão…" />
              {q && <button className="cc-search-clear" onClick={() => setQ('')} title="Limpar"><X size={11} /></button>}
            </div>
            {projectOptions.length > 1 && (
              <div className="cc-project-row">
                <select className="cc-select cc-mini-select" value={projectFilter} onChange={e => setProjectFilter(e.target.value)} title="Filtrar por projeto">
                  <option value="">Todos os projetos</option>
                  {projectOptions.map(([slug, label]) => <option key={slug} value={slug}>{label}</option>)}
                </select>
              </div>
            )}
            <div className="cc-filter-row">
              <button className={`cc-active ${activeOnly ? 'is-on' : ''}`} onClick={() => setActiveOnly(a => !a)} title="Mostrar só as ativas">
                <Bolt size={11} /> Ativas · {activeCount}
              </button>
              <select className="cc-select cc-mini-select" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)} title="Agrupar sessões">
                <option value="none">Sem agrupar</option>
                <option value="project">Por projeto</option>
                <option value="recency">Por data</option>
              </select>
            </div>
            {where === 'web' ? (
              <div className="cc-empty">Sessões na nuvem em breve</div>
            ) : loading ? (
              // Estado de carregamento inicial (localSessionsLoaded=false na extensão real) — antes
              // pulava direto pra "Nenhuma sessão" enquanto o primeiro fetch ainda estava em voo.
              <div className="cc-loading"><span className="cc-spinner" /> Carregando sessões…</div>
            ) : (
              <>
                {groups.map(g => (
                  <SessionGroupSection key={g.key} groupKey={g.key} label={g.label} sessions={g.sessions}
                    collapsible={groupBy !== 'none'} collapsed={collapsedGroups.has(g.key)} onToggle={() => toggleGroup(g.key)}
                    activeId={activeId} onSelect={onSelect} onRename={onRename} onArchive={onArchive} />
                ))}
                {localList.length === 0 && <div className="cc-empty">Nenhuma sessão</div>}
                {archivedList.length > 0 && (
                  <>
                    <div className="cc-group-head cc-clickable" onClick={() => setShowArchived(v => !v)}>
                      <Chevron size={11} className={`cc-chev ${showArchived ? 'is-open' : ''}`} /> Arquivadas <span className="cc-badge cc-badge-muted">{archivedList.length}</span>
                    </div>
                    {showArchived && (
                      <div className="cc-list">
                        {archivedList.map(s => (
                          <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={() => onSelect(s.id)} onRename={onRename} onArchive={onArchive} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
