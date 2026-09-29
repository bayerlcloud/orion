import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from './icons';

/** Uma imagem aberta no popup — `alt` é usado como `title`/`aria-label` do diálogo. */
export type LightboxImage = { src: string; alt: string };

/**
 * Popup de visualização de imagem — pedido ao vivo do Bayerl em 28/09/2026 ("a thumbnail de
 * imagem... copia a regra, UI... do plugin de claude code pra ficar 100% igual"), substituindo o
 * "abre em nova aba" que uma sessão anterior no mesmo dia tinha implementado (commit `5b445b6`).
 *
 * Replica o componente real da extensão (`AI0`/`yw` no webview decompilado v2.1.282,
 * `/srv/orion-reference/vscode-extension/extension/webview/index.js`) — o mesmo componente que a
 * extensão usa tanto pro anexo pendente no compositor quanto pra imagem de uma mensagem já enviada
 * (achado confirmado lendo os 4 call-sites de `yw(...)` no bundle: um dentro da renderização de
 * `content.type==="image"` de uma mensagem — histórico — e dois dentro da lista de anexos pendentes
 * do compositor). Valores exatos, lidos do CSS real (`webview/index.css`, classes `_vRjSkQ`), não
 * aproximados — ver PARIDADE.md pra cada citação:
 * - `previewOverlay_vRjSkQ`: `position:fixed;inset:0;z-index:10000;background:#000000d9;
 *   display:flex;justify-content:center;align-items:center` — preto a 85% de opacidade (`d9` hex =
 *   217/255 ≈ .851), NÃO 60% como um primeiro palpite sugeriria.
 * - `previewContainer_vRjSkQ`/`previewImage_vRjSkQ`: `max-width:90vw;max-height:90vh` — a imagem (e
 *   o container que a envolve) nunca passa de 90% da viewport em nenhuma das duas dimensões; como o
 *   overlay é flex centralizado em tela cheia, sobra pelo menos ~5vw/5vh de respiro (a "moldura com
 *   padding" pedida) em volta, em qualquer proporção de imagem. `object-fit:contain` (nunca corta a
 *   imagem), `border-radius:8px`, `box-shadow:0 4px 24px #00000080` (preto a 50%, `80` hex = 128/255
 *   ≈ .502).
 * - `previewCloseButton_vRjSkQ`: botão circular 28×28, `position:absolute;top:-12px;right:-12px` —
 *   sobreposto ao canto superior direito do container, não dentro dele.
 *
 * SEM navegação entre imagens (setas, tira de miniaturas, swipe): confirmado lendo o bundle inteiro
 * que não existe — o componente real é por-anexo, cada miniatura clicada monta sua PRÓPRIA instância
 * deste overlay (sem nenhum estado de galeria/índice compartilhado, nenhuma classe -Next-/-Prev-/
 * -Arrow-/-Nav- associada). Corrige a suposição inicial do pedido (Bayerl imaginou uma galeria com
 * setas ao descrever de memória) — aqui replicamos o que a extensão real FAZ, não o que se imaginou
 * que ela fazia; ver PARIDADE.md.
 *
 * Fechar: clique no backdrop (fora do container — mesma checagem `e.target === e.currentTarget` do
 * código real, então clicar na própria imagem NUNCA fecha), no botão "X", ou Esc — capturado em
 * `document` com `capture:true` e `stopImmediatePropagation`, igual
 * ao real, pra não vazar pro handler de Esc do compositor (foca/desfoca — ver Composer.tsx) enquanto
 * o popup está aberto. Foco vai pro botão de fechar ao abrir (mesmo comportamento real); sem restaurar
 * foco ao fechar (o componente real usado pra anexos — `AI0` — também não restaura; só a variante
 * usada pra screenshot do Chrome, `kv1`, um componente DIFERENTE e não usado aqui, faz isso).
 * Renderizado via portal em `document.body` (`createPortal`, igual ao `Mh1.createPortal` real) pra
 * nunca herdar overflow/stacking de nenhum ancestral.
 */
export default function Lightbox({ image, onClose }: { image: LightboxImage | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!image) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [image, onClose]);

  if (!image) return null;
  return createPortal(
    <div className="cc-preview-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-preview-container" role="dialog" aria-label={image.alt} tabIndex={-1}>
        <img src={image.src} alt={image.alt} className="cc-preview-image" />
        <button ref={closeRef} type="button" onClick={onClose} className="cc-preview-close" title="Fechar (Esc)">
          <X size={16} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
