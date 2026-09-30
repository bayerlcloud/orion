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
import Tarefas from './pages/Tarefas';
import Tools from './pages/Tools';
import { Dialogos } from './dialogo';
import { IcoArquivos, IcoClaude, IcoConfig, IcoDash, IcoDrive, IcoMemoria, IcoSair, IcoSpec, IcoTarefas, IcoTools } from './icons';

const MENU = [
  // Claude primeiro: é a página que abre por padrão e onde a equipe passa o dia.
  { to: '/claude', label: 'Claude', Icon: IcoClaude },
  { to: '/dash', label: 'Dash', Icon: IcoDash },
  { to: '/arquivos', label: 'Arquivos', Icon: IcoArquivos },
  { to: '/tarefas', label: 'Tarefas', Icon: IcoTarefas },
  { to: '/tools', label: 'Tools', Icon: IcoTools },
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
  // Página do menu em que a pessoa está ('/claude', '/dash'…) e as que já foram abertas (ficam montadas).
  const page = '/' + (loc.pathname.split('/')[1] ?? '');
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // Atalhos de teclado das páginas escondidas checam isto para não agir fora da própria página.
    document.body.dataset.page = page;
    setVisited(v => v.has(page) ? v : new Set(v).add(page));
  }, [page]);

  useEffect(() => {
    api<{ user: User }>('/api/me').then(r => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center muted">carregando…</div>;
  if (!user) return <Login onLogin={u => { setUser(u); nav('/claude'); }} />;

  async function sair() {
    await api('/api/logout', { method: 'POST' });
    setUser(null);
  }

  const KEEP = [
    { path: '/claude', el: <ClaudePage /> },
    { path: '/dash', el: <Dash /> },
    { path: '/arquivos', el: <Arquivos user={user} /> },
    { path: '/tarefas', el: <Tarefas user={user} /> },
    { path: '/tools', el: <Tools user={user} /> },
    { path: '/drive', el: <Drive user={user} /> },
    { path: '/memoria', el: <Memoria user={user} /> },
    { path: '/spec', el: <Spec user={user} /> },
    { path: '/config', el: <Config user={user} /> },
  ];
  const wide = loc.pathname.startsWith('/claude') || loc.pathname.startsWith('/arquivos');
  const dash = loc.pathname.startsWith('/dash');
  return (
    <div className="shell">
      <aside className="rail">
        <nav className="rail-nav">
          {MENU.filter(m => !m.ownerOnly || user.role === 'owner').map(m => (
            <NavLink key={m.to} to={m.to} className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`} title={m.label} aria-label={m.label}
              // Clicar em Claude estando já no Claude mostra/esconde a lista de sessões (fica só o chat).
              onClick={e => { if (m.to === '/claude' && loc.pathname.startsWith('/claude')) { e.preventDefault(); window.dispatchEvent(new Event('orion:toggle-claude-side')); } }}>
              <m.Icon />
              <span className="rail-label">{m.label}</span>
            </NavLink>
          ))}
        </nav>
        <Avatar user={user} onLogout={sair} onProfile={() => nav('/perfil')} />
      </aside>
      <main className={`content ${wide ? 'is-wide' : ''} ${dash ? 'is-dash' : ''}`}>
        {/* Páginas "vivas": cada página, depois de aberta uma vez, continua montada e só é escondida
            ao trocar de menu. Voltar é instantâneo (sem recarregar nem remontar) e ela segue se
            atualizando em segundo plano, igual às abas do Claude. */}
        {KEEP.filter(p => visited.has(p.path) || p.path === page).map(p => (
          <div key={p.path} className="page-keep" style={{ display: page === p.path ? 'contents' : 'none' }}>
            {p.el}
          </div>
        ))}
        <Routes>
          <Route path="/" element={<Navigate to="/claude" replace />} />
          {KEEP.map(p => <Route key={p.path} path={p.path} element={null} />)}
          <Route path="/perfil" element={<Perfil user={user} onSaved={() => api<{ user: User }>('/api/me').then(r => setUser(r.user)).catch(() => {})} />} />
          <Route path="*" element={<Navigate to="/claude" replace />} />
        </Routes>
      </main>
      <Dialogos />
    </div>
  );
}
