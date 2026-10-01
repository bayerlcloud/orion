import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dots, Eye, AgentMap as AgentMapIcon, Wrench, Shield, Puzzle, Pencil, Power } from './icons';

type Item = { icon: ReactNode; label: string; desc: string; onClick: () => void; disabled?: boolean; danger?: boolean; hidden?: boolean };

/**
 * Menu "⋮" da barra das abas: junta num lugar só as ações da sessão e as configurações do Claude
 * (antes eram 8 ícones soltos na barra). Fecha com Esc, clique fora ou ao escolher.
 */
export default function SessionMenu({ sessao, configurar, topo }: { sessao: Item[]; configurar: Item[]; topo?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const fora = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const render = (it: Item) => it.hidden ? null : (
    <button key={it.label} type="button" role="menuitem" className={`cc-smenu-item ${it.danger ? 'is-danger' : ''}`} disabled={it.disabled}
      onClick={() => { setOpen(false); it.onClick(); }}>
      <span className="cc-smenu-ico">{it.icon}</span>
      <span className="cc-smenu-txt"><span className="cc-smenu-label">{it.label}</span><span className="cc-smenu-desc">{it.desc}</span></span>
    </button>
  );
  return (
    <span className="cc-smenu" ref={ref}>
      <button type="button" className={`cc-icon ${open ? 'is-on' : ''}`} title="Mais ações" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><Dots size={14} /></button>
      {open && (
        <div className="cc-smenu-pop" role="menu">
          {topo && <>
            <div className="cc-smenu-title">Preview do projeto</div>
            <div className="cc-smenu-preview">{topo}</div>
            <div className="cc-smenu-sep" />
          </>}
          <div className="cc-smenu-title">Sessão</div>
          {sessao.map(render)}
          <div className="cc-smenu-sep" />
          <div className="cc-smenu-title">Configurar o Claude</div>
          {configurar.map(render)}
        </div>
      )}
    </span>
  );
}

export const menuIcons = { Eye, AgentMapIcon, Wrench, Shield, Puzzle, Pencil, Power };
