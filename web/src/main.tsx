import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './ui.css';

// tema salvo antes de renderizar (evita flash)
try { const th = localStorage.getItem('orion-theme'); if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th); } catch { /* sem storage */ }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
