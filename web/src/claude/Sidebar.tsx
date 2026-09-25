import { useState } from 'react';
import type { SessionSummary } from './types';
import { relativeTime } from './mapper';
import { Chevron, Plus, Search, Filter, Bolt } from './icons';

type Usage = { label: string; pct: number; note: string };

export default function Sidebar({ sessions, usage, activeId, onSelect, onNew }:
  { sessions: SessionSummary[]; usage: Usage[]; activeId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const [where, setWhere] = useState<'local' | 'web'>('local');
  const [open, setOpen] = useState(true);
  const active = sessions.filter(s => s.status === 'running' || s.status === 'waiting').length;
  const list = where === 'local' ? sessions : [];
  return (
    <aside className="cc-side">
      <div className="cc-side-title">CLAUDE CODE</div>

      <section className="cc-section">
        <div className="cc-section-head"><Chevron size={12} className="cc-chev is-open" /> CONTA E USO <a className="cc-link" href="#">Ver detalhes</a></div>
        <div className="cc-usage-title">USO</div>
        {usage.map(u => (
          <div key={u.label} className="cc-usage">
            <div className="cc-usage-head"><span>{u.label}</span><span>{u.pct}%</span></div>
            <div className="cc-track"><div className="cc-fill" style={{ width: `${u.pct}%` }} /></div>
            <div className="cc-usage-note">{u.note}</div>
          </div>
        ))}
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
            <div className="cc-filter-row">
              <span className="cc-muted"><Filter size={12} /></span>
              <span className="cc-active"><Bolt size={11} /> Ativas · {active}</span>
              <span className="cc-muted"><Search size={12} /></span>
              <span className="cc-spacer" />
              <button className="cc-link-btn"><Plus size={11} /> Novo grupo</button>
            </div>
            <div className="cc-group-head"><Chevron size={11} className="cc-chev is-open" /> Sem grupo <span className="cc-badge">{list.length}</span></div>
            <div className="cc-list">
              {list.length === 0 && <div className="cc-empty">Nenhuma sessão web ainda</div>}
              {list.map(s => (
                <button key={s.id} className={`cc-item ${s.id === activeId ? 'is-active' : ''}`} onClick={() => onSelect(s.id)}>
                  <span className={`cc-dot is-${s.status}`} />
                  <span className="cc-item-name">{s.title}</span>
                  <span className="cc-item-time">{relativeTime(s.updatedAt)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </aside>
  );
}
