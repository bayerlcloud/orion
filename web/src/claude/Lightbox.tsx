import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chevron, X } from './icons';

/** Uma imagem aberta no popup — `alt` é usado como `title`/`aria-label` do diálogo. */
export type LightboxImage = { src: string; alt: string };

/**
 * Popup de visualização de imagem. Base copiada do preview real da extensão (`AI0`/`yw` no webview
 * v2.1.282, classes `_vRjSkQ`; ver PARIDADE.md): Esc capturado em `document` com
 * `stopImmediatePropagation` (não vaza pro Esc do compositor), clique no fundo fecha e na imagem não.
 *
 * Diferenças pedidas pelo Danilo em 29/09/2026 (a extensão real NÃO tem galeria; é escolha dele, não
 * "corrija" de volta): fundo preto 80% com desfoque, badge "Fechar" no canto superior direito da tela,
 * imagem com no máximo 70% da tela (15% de respiro de cada lado) e, com mais de uma imagem, galeria:
 * setas na tela, ←/→ no teclado, deslize de dedo e tira de miniaturas embaixo.
 * Portal dentro do `.cc` (não no body) pra herdar as variáveis de tema `--cc-*`.
 */
export default function Lightbox({ images, index, onClose }: { images: LightboxImage[]; index: number | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  const [i, setI] = useState(0);
  const open = index !== null && images.length > 0;
  const n = images.length;
  const go = (d: number) => setI(v => (v + d + n) % n);

  useEffect(() => { if (index !== null) setI(index); }, [index]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); onClose(); }
      else if (n > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault(); e.stopImmediatePropagation();
        setI(v => (v + (e.key === 'ArrowLeft' ? -1 : 1) + n) % n);
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, n, onClose]);

  if (!open) return null;
  const image = images[Math.min(i, n - 1)];
  return createPortal(
    <div className="cc-preview-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={e => {
        const x0 = touchX.current; touchX.current = null;
        if (x0 === null || n < 2) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      }}>
      <div className="cc-preview-container" role="dialog" aria-label={image.alt} tabIndex={-1}>
        <img src={image.src} alt={image.alt} className="cc-preview-image" draggable={false} />
      </div>
      <button ref={closeRef} type="button" onClick={onClose} className="cc-preview-close" title="Fechar (Esc)">
        <X size={12} /> Fechar
      </button>
      {n > 1 && <>
        <button type="button" className="cc-preview-nav is-prev" onClick={() => go(-1)} title="Anterior (←)"><Chevron size={20} /></button>
        <button type="button" className="cc-preview-nav is-next" onClick={() => go(1)} title="Próxima (→)"><Chevron size={20} /></button>
        <div className="cc-preview-strip">
          {images.map((m, k) => (
            <button key={k} type="button" className={k === i ? 'is-on' : ''} onClick={() => setI(k)} title={m.alt}>
              <img src={m.src} alt="" draggable={false} />
            </button>
          ))}
        </div>
      </>}
    </div>,
    document.querySelector('.cc') ?? document.body,
  );
}
