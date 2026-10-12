import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './ui.css';

// tema salvo antes de renderizar (evita flash)
try {
  const th = localStorage.getItem('orion-theme');
  const resolvido = th === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : th;
  if (resolvido === 'light' || resolvido === 'dark') document.documentElement.setAttribute('data-theme', resolvido);
  if (th === 'system') {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
    });
  }
} catch { /* sem storage */ }

// links para fora do painel (outro domínio) sempre abrem em nova aba; rotas internas seguem na mesma
document.addEventListener('click', e => {
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (a && a.origin !== location.origin && /^https?:$/.test(a.protocol)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
}, true);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
