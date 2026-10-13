import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './ui.css';
import { iniciarTema } from './tema';

// tema salvo antes de renderizar (evita flash)
iniciarTema();

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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// Celular: altura real visível (encolhe quando o teclado abre, inclusive no iPhone, que não redimensiona
// a página sozinho). A casca usa --app-h no lugar de 100dvh.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const ajustar = () => document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
  vv.addEventListener('resize', ajustar);
  ajustar();
}
