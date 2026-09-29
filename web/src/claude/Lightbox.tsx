import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chevron, X } from './icons';

export type LightboxImage = { url: string; name: string };

/** Visualizador de imagens em popup: fundo preto 60%, setas/teclado/deslize para alternar, miniaturas embaixo. */
export function Lightbox({ images, start, onClose }: { images: LightboxImage[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const touchX = useRef<number | null>(null);
  const n = images.length;
  const go = (d: number) => setI(v => (v + d + n) % n);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const img = images[i];
  if (!img) return null;
  return createPortal(
    <div className="cc-lb" onClick={onClose}
      onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={e => {
        if (touchX.current === null || n < 2) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      }}>
      <button className="cc-lb-close" onClick={onClose} title="Fechar (Esc)"><X size={18} /></button>
      <img className="cc-lb-img" src={img.url} alt={img.name} onClick={e => e.stopPropagation()} />
      <div className="cc-lb-name">{img.name}{n > 1 && ` · ${i + 1}/${n}`}</div>
      {n > 1 && <>
        <button className="cc-lb-nav is-prev" onClick={e => { e.stopPropagation(); go(-1); }} title="Anterior (←)"><Chevron size={22} /></button>
        <button className="cc-lb-nav is-next" onClick={e => { e.stopPropagation(); go(1); }} title="Próxima (→)"><Chevron size={22} /></button>
        <div className="cc-lb-strip" onClick={e => e.stopPropagation()}>
          {images.map((m, k) => (
            <img key={k} src={m.url} alt={m.name} className={k === i ? 'is-on' : ''} onClick={() => setI(k)} />
          ))}
        </div>
      </>}
    </div>,
    document.body,
  );
}
