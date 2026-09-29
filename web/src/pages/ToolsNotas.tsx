import { useState } from 'react';

/** Explicação de uma conta no card: 4 linhas e "ver mais". */
export default function ToolsNotas({ texto }: { texto: string }) {
  const [open, setOpen] = useState(false);
  if (!texto.trim()) return null;
  const longa = texto.length > 170 || texto.split('\n').length > 4;
  return (
    <>
      <p className={`tls-notes ${open ? 'is-open' : ''}`}>{texto}</p>
      {longa && <button className="tls-more" onClick={() => setOpen(o => !o)}>{open ? 'ver menos' : 'ver mais'}</button>}
    </>
  );
}

export function copiar(t: string) { void navigator.clipboard?.writeText(t); }
