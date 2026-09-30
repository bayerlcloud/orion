import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

/**
 * Campo de texto do compositor feito com `contentEditable="plaintext-only"` em vez de `<textarea>`.
 * Motivo (pedido do Danilo, 30/09/2026): no iPhone o Safari mostra a barra de senha/cartão/endereço
 * em cima do teclado em todo `<textarea>`/`<input>` e ignora `autocomplete="off"`; em área editável
 * ela não aparece (mesma técnica de Slack/Notion na web). Expõe o mínimo que o Composer usava do
 * textarea: foco, texto e posição do cursor em caracteres.
 */
export type PlainInputHandle = {
  el: HTMLDivElement | null;
  focus: () => void;
  blur: () => void;
  getSelection: () => { start: number; end: number };
  setCaret: (pos: number) => void;
};

function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return r.toString().length;
}

function placeCaret(root: HTMLElement, pos: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = pos;
  let node = walker.nextNode();
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (left <= len) { r.setStart(node, left); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return; }
    left -= len;
    node = walker.nextNode();
  }
  r.selectNodeContents(root); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  className?: string;
};

const PlainInput = forwardRef<PlainInputHandle, Props>(function PlainInput({ value, onChange, onKeyDown, onPaste, placeholder, className }, ref) {
  const el = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    get el() { return el.current; },
    focus: () => el.current?.focus(),
    blur: () => el.current?.blur(),
    getSelection: () => {
      const root = el.current, sel = window.getSelection();
      if (!root || !sel || !sel.rangeCount || !root.contains(sel.anchorNode)) { const n = root?.textContent?.length ?? 0; return { start: n, end: n }; }
      const r = sel.getRangeAt(0);
      return { start: offsetOf(root, r.startContainer, r.startOffset), end: offsetOf(root, r.endContainer, r.endOffset) };
    },
    setCaret: (pos: number) => { if (el.current) placeCaret(el.current, pos); },
  }), []);

  // Valor vindo de fora (envio limpa, histórico, ditado, comando "/"): reescreve o conteúdo e põe o
  // cursor no fim. Digitação normal não passa por aqui (o DOM já tem o mesmo texto).
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || (root.textContent ?? '') === value) return;
    root.textContent = value;
    if (document.activeElement === root) placeCaret(root, value.length);
  }, [value]);

  return (
    <div className={`cc-input-wrap ${className ?? ''}`}>
      {!value && placeholder && <div className="cc-input-placeholder" aria-hidden="true">{placeholder}</div>}
      <div ref={el} className="cc-input" role="textbox" aria-multiline="true" aria-label={placeholder}
        contentEditable="plaintext-only" suppressContentEditableWarning spellCheck enterKeyHint="send"
        onInput={e => onChange((e.currentTarget.textContent ?? '').replace(/ /g, ' '))}
        onKeyDown={onKeyDown} onPaste={onPaste} />
    </div>
  );
});

export default PlainInput;
