import { useEffect, useRef, useState } from 'react';

/**
 * Janelas do Orion no lugar de window.confirm/alert/prompt (regra do Danilo, 01/10/2026: nunca
 * pop-up do navegador). Chamada igual à nativa, mas com await: `if (!(await confirmar('...'))) return;`.
 * O <Dialogos /> fica montado uma vez no App e mostra um pedido por vez, em fila.
 */

type Pedido =
  | { tipo: 'confirmar'; texto: string; titulo?: string; ok?: string; perigo?: boolean; fim: (v: boolean) => void }
  | { tipo: 'avisar'; texto: string; titulo?: string; fim: () => void }
  | { tipo: 'perguntar'; texto: string; titulo?: string; inicial?: string; ok?: string; fim: (v: string | null) => void };

const fila: Pedido[] = [];
let mudou: (() => void) | null = null;
const pedir = (p: Pedido) => { fila.push(p); mudou?.(); };

export function confirmar(texto: string, o: { titulo?: string; ok?: string; perigo?: boolean } = {}): Promise<boolean> {
  return new Promise(fim => pedir({ tipo: 'confirmar', texto, ...o, fim }));
}
export function avisar(texto: string, titulo?: string): Promise<void> {
  return new Promise(fim => pedir({ tipo: 'avisar', texto, titulo, fim }));
}
export function perguntar(texto: string, inicial = '', o: { titulo?: string; ok?: string } = {}): Promise<string | null> {
  return new Promise(fim => pedir({ tipo: 'perguntar', texto, inicial, ...o, fim }));
}

export function Dialogos() {
  const [, setN] = useState(0);
  const [valor, setValor] = useState('');
  const campo = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { mudou = () => setN(n => n + 1); if (fila.length) mudou(); return () => { mudou = null; }; }, []);
  const p = fila[0];
  useEffect(() => {
    if (!p) return;
    if (p.tipo === 'perguntar') { setValor(p.inicial ?? ''); setTimeout(() => campo.current?.select(), 0); }
    else setTimeout(() => okBtn.current?.focus(), 0);
  }, [p]);
  if (!p) return null;
  const fechar = (sim: boolean) => {
    fila.shift();
    if (p.tipo === 'confirmar') p.fim(sim);
    else if (p.tipo === 'avisar') p.fim();
    else p.fim(sim ? valor : null);
    setN(n => n + 1);
  };
  return (
    <div className="dlg-bg" onMouseDown={e => { if (e.target === e.currentTarget) fechar(false); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); fechar(false); } }}>
      <div className="dlg" role={p.tipo === 'avisar' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={p.titulo ?? p.texto}>
        {p.titulo && <div className="dlg-titulo">{p.titulo}</div>}
        <div className="dlg-texto">{p.texto}</div>
        {p.tipo === 'perguntar' && (
          <input ref={campo} className="dlg-campo" value={valor} onChange={e => setValor(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fechar(true); } }} />
        )}
        <div className="dlg-botoes">
          {p.tipo !== 'avisar' && <button type="button" className="dlg-btn" onClick={() => fechar(false)}>Cancelar</button>}
          <button type="button" ref={okBtn} className={`dlg-btn primario ${p.tipo === 'confirmar' && p.perigo ? 'perigo' : ''}`} onClick={() => fechar(true)}>
            {p.tipo === 'avisar' ? 'OK' : p.ok ?? (p.tipo === 'perguntar' ? 'Salvar' : 'Confirmar')}
          </button>
        </div>
      </div>
    </div>
  );
}
