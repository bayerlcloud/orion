import { useCallback, useEffect, useState } from 'react';

/**
 * Peças leves do painel lateral "Orion": ícone e estado aberto/fechado (localStorage + evento
 * global de alternar), sem puxar claude/api.ts nem claude/live.ts. Usadas por App.tsx e
 * ClaudePage.tsx de forma estática (bundle inicial). O corpo pesado do painel (chat, streaming)
 * está em OrionPanelBody.tsx, lazy em App.tsx.
 */
const KEY = 'orion:painel-direito';
// Evento global de alternar: o botão do canto (App.tsx, todas as páginas) e o botão dentro da barra
// de abas do Claude (ClaudePage.tsx — pedido do Danilo, 04/10/2026: trocar os dois de lugar, ⋮ pro
// canto e este botão pra dentro da barra) chamam `useOrionPanel()` cada um na sua própria instância;
// sem esse evento, cada instância teria seu próprio `open` e um botão não saberia que o outro mudou.
const EVENTO = 'orion:painel-direito-toggle';

export function IcoPainelDireito({ open, size = 18 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      {open && <path d="M15 4h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3z" fill="currentColor" stroke="none" />}
      <path d="M15 4v16" />
    </svg>
  );
}

export function useOrionPanel() {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) === '1');
  useEffect(() => { localStorage.setItem(KEY, open ? '1' : '0'); }, [open]);
  useEffect(() => {
    const h = () => setOpen(o => !o);
    window.addEventListener(EVENTO, h);
    return () => window.removeEventListener(EVENTO, h);
  }, []);
  const toggle = useCallback(() => window.dispatchEvent(new Event(EVENTO)), []);
  return [open, toggle] as const;
}
