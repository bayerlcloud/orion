import { useState } from 'react';
import type { SessionSummary } from './types';
import type { UsageBar } from './mapper';
import { relativeTime } from './mapper';
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

export default function Sidebar({ sessions, usage, usageNote, email, activeId, onSelect, onNew, onRename, onArchive }:
  { sessions: SessionSummary[]; usage: UsageBar[]; usageNote?: string; email: string | null; activeId: string | null;
    onSelect: (id: string) => void; onNew: () => void; onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void; }) {
  const [where, setWhere] = useState<'local' | 'web'>('local');
  const [open, setOpen] = useState(true);
  const [acctOpen, setAcctOpen] = useState(true);
  const [q, setQ] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const isActive = (s: SessionSummary) => s.status === 'running' || s.status === 'waiting';
  const activeCount = sessions.filter(isActive).length;
  const term = q.trim().toLowerCase();
  const match = (s: SessionSummary) => (!term || s.title.toLowerCase().includes(term)) && (!activeOnly || isActive(s));
  const localList = where === 'local' ? sessions.filter(s => !s.archived && match(s)) : [];
  const archivedList = where === 'local' ? sessions.filter(s => s.archived && match(s)) : [];

  return (
    <aside className="cc-side">
      <div className="cc-side-title">CLAUDE CODE</div>

      <section className="cc-section">
        <div className="cc-section-head" onClick={() => setAcctOpen(o => !o)}>
          <Chevron size={12} className={`cc-chev ${acctOpen ? 'is-open' : ''}`} /> CONTA E USO
        </div>
        {acctOpen && (
          <>
            <div className="cc-account">
              <div className="cc-account-row"><span className="cc-account-label">CONTA</span><span className="cc-account-value">{email ?? '—'}</span></div>
            </div>
            <div className="cc-usage-title">USO</div>
            {usage.map(u => (
              <div key={u.key} className="cc-usage">
                <div className="cc-usage-head"><span>{u.label}</span><span>{u.pct}%</span></div>
                <div className="cc-track"><div className={`cc-fill ${u.pct >= 90 ? 'is-high' : ''}`} style={{ width: `${u.pct}%` }} /></div>
                <div className="cc-usage-note">{u.sub}</div>
              </div>
            ))}
            {usageNote && <div className="cc-usage-hint">{usageNote}</div>}
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
            <div className="cc-filter-row">
              <button className={`cc-active ${activeOnly ? 'is-on' : ''}`} onClick={() => setActiveOnly(a => !a)} title="Mostrar só as ativas">
                <Bolt size={11} /> Ativas · {activeCount}
              </button>
            </div>
            {where === 'web' ? (
              <div className="cc-empty">Sessões na nuvem em breve</div>
            ) : (
              <>
                <div className="cc-group-head"><Chevron size={11} className="cc-chev is-open" /> Sem grupo <span className="cc-badge">{localList.length}</span></div>
                <div className="cc-list">
                  {localList.length === 0 && <div className="cc-empty">Nenhuma sessão</div>}
                  {localList.map(s => (
                    <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={() => onSelect(s.id)} onRename={onRename} onArchive={onArchive} />
                  ))}
                </div>
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
