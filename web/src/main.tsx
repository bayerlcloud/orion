import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './ui.css';
import { iniciarTema } from './tema';

// tema salvo antes de renderizar (evita flash)
iniciarTema();

/**
 * Sem isso, qualquer erro de render (ex.: aba volta de muito tempo em segundo plano com um estado
 * esperando algo que não chegou) desmontava a árvore inteira: sobrava só o body com o tema escuro,
 * ou seja, tela preta sem nenhum erro visível (relato do Danilo, 06/11/2026) — só F5 resolvia porque
 * nada aqui recarregava sozinho. Recarrega uma vez sozinho; se persistir, mostra o erro.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    // Manda pro servidor ANTES de recarregar — sem isso, a 1ª ocorrência (a maioria dos casos,
    // já que o reload quase sempre resolve) sumia sem deixar rastro nenhum pra diagnosticar.
    try {
      fetch('/api/claude/client-error', {
        method: 'POST', keepalive: true, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: error.message, stack: error.stack, url: location.href }),
      }).catch(() => {});
    } catch { /* no-op */ }
    const key = 'orion-crash-reload-at';
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last > 10_000) { sessionStorage.setItem(key, String(Date.now())); location.reload(); return; }
    console.error('Orion travou e já tentou recarregar uma vez:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#ccc' }}>
          Algo travou na interface. <button onClick={() => location.reload()}>Recarregar</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// links para fora do painel (outro domínio) sempre abrem em nova aba; rotas internas seguem na mesma
document.addEventListener('click', e => {
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (a && a.origin !== location.origin && /^https?:$/.test(a.protocol)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
}, true);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
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
