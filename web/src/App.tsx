import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, type User } from './api';
import Login from './pages/Login';
import Spec from './pages/Spec';
import Placeholder from './pages/Placeholder';
import ClaudePage from './claude/ClaudePage';
import Drive from './pages/Drive';
import Config from './pages/Config';
import Dash from './pages/Dash';
import Arquivos from './pages/Arquivos';
import Memoria from './pages/Memoria';
import Perfil from './pages/Perfil';
import { IcoArquivos, IcoClaude, IcoConfig, IcoDash, IcoDrive, IcoMemoria, IcoSair, IcoSpec } from './icons';

const MENU = [
  { to: '/claude', label: 'Claude', Icon: IcoClaude },
  { to: '/dash', label: 'Dash', Icon: IcoDash },
  { to: '/arquivos', label: 'Arquivos', Icon: IcoArquivos },
  { to: '/drive', label: 'Drive', Icon: IcoDrive },
  { to: '/memoria', label: 'Memória', Icon: IcoMemoria },
  { to: '/spec', label: 'Spec', Icon: IcoSpec },
  { to: '/config', label: 'Configurações', Icon: IcoConfig, ownerOnly: true },
];

function Avatar({ user, onLogout, onProfile }: { user: User; onLogout: () => void; onProfile: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const inicial = (user.name || user.email).trim().charAt(0).toUpperCase();
  return (
    <div className="avatar-wrap" ref={ref}>
      <button className="avatar" onClick={() => setOpen(o => !o)} title={user.name} aria-label="Menu do usuário">
        <img className="avatar-img" src={`/api/profile/avatar/${user.id}`} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        <span className="avatar-ini">{inicial}</span>
      </button>
      {open && (
        <div className="avatar-menu">
          <div className="avatar-name">{user.name}</div>
          <div className="avatar-role">{user.role === 'owner' ? 'admin' : 'membro'} · {user.email}</div>
          <button className="avatar-item" onClick={() => { setOpen(false); onProfile(); }}><IcoConfig size={14} /> configurações</button>
          <button className="avatar-item" onClick={onLogout}><IcoSair size={14} /> sair</button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    api<{ user: User }>('/api/me').then(r => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center muted">carregando…</div>;
  if (!user) return <Login onLogin={u => { setUser(u); nav('/claude'); }} />;

  async function sair() {
    await api('/api/logout', { method: 'POST' });
    setUser(null);
  }

  const wide = loc.pathname.startsWith('/claude') || loc.pathname.startsWith('/arquivos');
  const dash = loc.pathname.startsWith('/dash');
  return (
    <div className="shell">
      <aside className="rail">
        <nav className="rail-nav">
          {MENU.filter(m => !m.ownerOnly || user.role === 'owner').map(m => (
            <NavLink key={m.to} to={m.to} className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`} title={m.label} aria-label={m.label}>
              <m.Icon />
              <span className="rail-label">{m.label}</span>
            </NavLink>
          ))}
        </nav>
        <Avatar user={user} onLogout={sair} onProfile={() => nav('/perfil')} />
      </aside>
      <main className={`content ${wide ? 'is-wide' : ''} ${dash ? 'is-dash' : ''}`}>
        <Routes>
          <Route path="/" element={<Navigate to="/claude" replace />} />
          <Route path="/spec" element={<Spec user={user} />} />
          <Route path="/dash" element={<Dash />} />
          <Route path="/claude" element={<ClaudePage />} />
          <Route path="/memoria" element={<Memoria user={user} />} />
          <Route path="/arquivos" element={<Arquivos user={user} />} />
          <Route path="/drive" element={<Drive user={user} />} />
          <Route path="/config" element={<Config user={user} />} />
          <Route path="/perfil" element={<Perfil user={user} onSaved={() => api<{ user: User }>('/api/me').then(r => setUser(r.user)).catch(() => {})} />} />
          <Route path="*" element={<Navigate to="/claude" replace />} />
        </Routes>
      </main>
    </div>
  );
}
