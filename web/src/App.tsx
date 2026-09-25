import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, type User } from './api';
import Login from './pages/Login';
import Spec from './pages/Spec';
import Placeholder from './pages/Placeholder';
import ClaudePage from './claude/ClaudePage';
import Drive from './pages/Drive';
import Config from './pages/Config';

const MENU = [
  { to: '/spec', label: 'Spec' },
  { to: '/dash', label: 'Dash' },
  { to: '/claude', label: 'Claude' },
  { to: '/memoria', label: 'Memória' },
  { to: '/arquivos', label: 'Arquivos' },
  { to: '/drive', label: 'Drive' },
  { to: '/config', label: 'Configurações' },
];

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    api<{ user: User }>('/api/me').then(r => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center muted">carregando…</div>;
  if (!user) return <Login onLogin={u => { setUser(u); nav('/spec'); }} />;

  async function sair() {
    await api('/api/logout', { method: 'POST' });
    setUser(null);
  }

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">ORION</div>
        <nav>
          {MENU.map(m => <NavLink key={m.to} to={m.to} className={({ isActive }) => isActive ? 'active' : ''}>{m.label}</NavLink>)}
        </nav>
        <div className="me">
          <div>{user.name}</div>
          <div className="muted small">{user.role === 'owner' ? 'admin' : 'membro'}</div>
          <button className="link" onClick={sair}>sair</button>
        </div>
      </aside>
      <main className={`content ${loc.pathname.startsWith('/claude') ? 'is-wide' : ''}`}>
        <Routes>
          <Route path="/" element={<Navigate to="/spec" replace />} />
          <Route path="/spec" element={<Spec user={user} />} />
          <Route path="/dash" element={<Placeholder title="Dash" text="Visão dos servidores e das sessões em andamento. Vai reaproveitar o coletor v2 que já roda na c1, c2 e Hostinger." />} />
          <Route path="/claude" element={<ClaudePage />} />
          <Route path="/memoria" element={<Placeholder title="Memória" text="Regras por projeto, perfil de cada pessoa e o que a Central injeta em toda sessão." />} />
          <Route path="/arquivos" element={<Placeholder title="Arquivos" text="Repositórios e worktrees na c3, com diff do que cada tarefa alterou." />} />
          <Route path="/drive" element={<Drive user={user} />} />
          <Route path="/config" element={<Config user={user} />} />
          <Route path="*" element={<Navigate to="/spec" replace />} />
        </Routes>
      </main>
    </div>
  );
}
