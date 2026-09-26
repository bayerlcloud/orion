import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { sep: true }
  | { sep?: false; label: string; hint?: string; disabled?: boolean; onClick: () => void };

type Props = { x: number; y: number; items: MenuItem[]; onClose: () => void };

/** Menu de contexto simples: posição fixa, fecha com clique fora, Escape ou rolagem; setas navegam. */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [hi, setHi] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 4 ? Math.max(4, x - r.width) : x;
    const ny = y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      const enabled = items.map((it, i) => (!it.sep && !it.disabled ? i : -1)).filter(i => i >= 0);
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!enabled.length) return;
        const cur = enabled.indexOf(hi);
        const next = e.key === 'ArrowDown' ? enabled[(cur + 1) % enabled.length] : enabled[(cur - 1 + enabled.length) % enabled.length];
        setHi(next);
      } else if (e.key === 'Enter' && hi >= 0) {
        e.preventDefault();
        const it = items[hi];
        if (!it.sep && !it.disabled) { onClose(); it.onClick(); }
      }
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [items, hi, onClose]);

  return (
    <div ref={ref} className="arq-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => it.sep
        ? <div key={i} className="arq-menu-sep" />
        : (
          <div
            key={i}
            role="menuitem"
            className={`arq-menu-item${it.disabled ? ' is-disabled' : ''}${hi === i ? ' is-hi' : ''}`}
            onMouseEnter={() => setHi(i)}
            onClick={() => { if (it.disabled) return; onClose(); it.onClick(); }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="arq-menu-key">{it.hint}</span>}
          </div>
        ))}
    </div>
  );
}
