import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './ui.css';
import { iniciarTema } from './tema';

// tema salvo antes de renderizar (evita flash)
iniciarTema();

// Notebook fechado/suspenso por muito tempo com a aba aberta: ao voltar, o app às vezes trava num
// estado quebrado (tela preta, sem erro visível). Em vez de o usuário ter que atualizar na mão,
// recarrega sozinho quando a aba ficou oculta por mais de 5 min.
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenSince = Date.now(); return; }
  if (hiddenSince && Date.now() - hiddenSince > 5 * 60_000) location.reload();
  hiddenSince = 0;
});

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
