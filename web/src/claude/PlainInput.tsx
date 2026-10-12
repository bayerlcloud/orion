import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { perguntar } from '../dialogo';
import { normalizeUrl, renderMd, serializeMd } from './rich';

/**
 * Campo de texto do compositor: área editável (`contentEditable`) em vez de `<textarea>`.
 * Motivo (pedido do Danilo, 30/09/2026): no iPhone o Safari mostra a barra de senha/cartão/endereço
 * em cima do teclado em todo `<textarea>`/`<input>` e ignora `autocomplete="off"`; em área editável
 * ela não aparece. Aceita formatação (Gustavo, 13/10/2026): o `value` é markdown (ver rich.ts) e o
 * DOM é a vista dele. Posições do cursor são em caracteres visíveis (sem as marcas do markdown).
 */
export type PlainInputHandle = {
  el: HTMLDivElement | null;
  focus: () => void;
  blur: () => void;
  getSelection: () => { start: number; end: number; total: number };
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

const exec = (cmd: string, arg?: string) => document.execCommand(cmd, false, arg);

/** Texto da linha atual, do início dela até o cursor (para "- " e "1. " virarem lista). */
function lineBeforeCaret(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed || !root.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  let block: Node | null = r.startContainer;
  while (block && block !== root && !/^(DIV|P|LI)$/.test((block as Element).tagName ?? '')) block = block.parentNode;
  if (!block || (block as Element).tagName === 'LI' || (block as Element).closest?.('li')) return null;
  const pre = document.createRange();
  pre.setStart(block, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  let line = '';
  const walk = (n: Node) => {
    if (n.nodeName === 'BR') line = '';
    else if (n.nodeType === Node.TEXT_NODE) line += n.textContent;
    else n.childNodes.forEach(walk);
  };
  pre.cloneContents().childNodes.forEach(walk);
  // Com white-space: pre-wrap o Chrome quebra linha com "\n" no próprio texto, não com <br>.
  return line.slice(line.lastIndexOf('\n') + 1).replace(/ /g, ' ');
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  /** Mostra o atalho "Tab" junto do placeholder (a sugestão de prompt entra com Tab). */
  placeholderTab?: boolean;
  className?: string;
  /**
   * Alguém meteu algo no DOM por fora do React (ex.: o marcador de ditado do Composer) e esse
   * `value` por enquanto não reflete isso: `true` pausa a ressincronização abaixo.
   */
  freeze?: boolean;
};

const PlainInput = forwardRef<PlainInputHandle, Props>(function PlainInput({ value, onChange, onKeyDown, onPaste, placeholder, placeholderTab, className, freeze }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const emit = () => { if (el.current) onChange(serializeMd(el.current)); };
  useImperativeHandle(ref, () => ({
    get el() { return el.current; },
    focus: () => el.current?.focus(),
    blur: () => el.current?.blur(),
    getSelection: () => {
      const root = el.current, sel = window.getSelection();
      const total = root ? offsetOf(root, root, root.childNodes.length) : 0;
      if (!root || !sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return { start: total, end: total, total };
      const r = sel.getRangeAt(0);
      return { start: offsetOf(root, r.startContainer, r.startOffset), end: offsetOf(root, r.endContainer, r.endOffset), total };
    },
    setCaret: (pos: number) => { if (el.current) placeCaret(el.current, pos); },
  }), []);

  // Valor vindo de fora (envio limpa, histórico, rascunho, comando "/"): redesenha e põe o cursor no
  // fim. Digitação normal não passa por aqui (o DOM já serializa para o mesmo markdown).
  useLayoutEffect(() => {
    if (freeze) return;
    const root = el.current;
    if (!root || serializeMd(root) === value) return;
    renderMd(root, value);
    if (document.activeElement === root) placeCaret(root, Infinity);
  }, [value, freeze]);

  // Barra de formatação flutuante sobre o texto selecionado.
  const [bar, setBar] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const onSel = () => {
      const root = el.current, sel = window.getSelection();
      if (!root || !sel?.rangeCount || sel.isCollapsed || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) { setBar(null); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = root.parentElement!.getBoundingClientRect();
      setBar({ top: rect.top - box.top, left: Math.max(0, rect.left - box.left + rect.width / 2) });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  async function addLink() {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const atual = (sel?.anchorNode?.parentElement?.closest('a') as HTMLAnchorElement | null)?.getAttribute('href') ?? '';
    const v = await perguntar('Endereço do link (vazio remove)', atual, { titulo: 'Link', ok: 'Aplicar' });
    if (v === null || !range || !el.current) return;
    el.current.focus();
    sel!.removeAllRanges(); sel!.addRange(range);
    const url = normalizeUrl(v);
    if (url) exec('createLink', url); else exec('unlink');
    emit();
  }

  function format(cmd: 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList') { exec(cmd); emit(); }

  function key(e: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const root = el.current!;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); return; } // sublinhado não existe no markdown
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); void addLink(); return; }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      const sel = window.getSelection();
      const inLi = sel?.anchorNode && (sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode as Element : sel.anchorNode.parentElement)?.closest('li');
      exec(inLi && root.contains(inLi) ? 'insertParagraph' : 'insertLineBreak');
      emit();
      return;
    }
    // "- " / "* " / "1. " no começo da linha viram lista.
    if (e.key === ' ' && !mod) {
      const line = lineBeforeCaret(root);
      const kind = line === '-' || line === '*' ? 'insertUnorderedList' : line && /^\d+\.$/.test(line) ? 'insertOrderedList' : null;
      if (kind) {
        e.preventDefault();
        for (let i = 0; i < line!.length; i++) exec('delete');
        exec(kind);
        emit();
      }
    }
  }

  function paste(e: ClipboardEvent<HTMLDivElement>) {
    onPaste?.(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const sel = window.getSelection();
    const url = sel && !sel.isCollapsed ? normalizeUrl(text) : null;
    // URL colada sobre um texto selecionado vira link nesse texto.
    if (url && /^https?:\/\//i.test(text.trim())) exec('createLink', url);
    else exec('insertText', text);
    emit();
  }

  return (
    <div className={`cc-input-wrap ${className ?? ''}`}>
      {!value && placeholder && (
        <div className="cc-input-placeholder" aria-hidden="true">
          {placeholder}{placeholderTab && <kbd className="cc-input-tab">Tab</kbd>}
        </div>
      )}
      {bar && (
        <div className="cc-format-bar" style={{ top: bar.top, left: bar.left }} onMouseDown={e => e.preventDefault()}>
          <button type="button" title="Negrito (⌘B)" onClick={() => format('bold')}><b>B</b></button>
          <button type="button" title="Itálico (⌘I)" onClick={() => format('italic')}><i>I</i></button>
          <button type="button" title="Lista" onClick={() => format('insertUnorderedList')}>•</button>
          <button type="button" title="Lista numerada" onClick={() => format('insertOrderedList')}>1.</button>
          <button type="button" title="Link (⌘K)" onClick={() => void addLink()}>Link</button>
        </div>
      )}
      <div ref={el} className="cc-input" role="textbox" aria-multiline="true" aria-label={placeholder}
        contentEditable suppressContentEditableWarning spellCheck enterKeyHint="send"
        onInput={emit} onKeyDown={key} onPaste={paste} />
    </div>
  );
});

export default PlainInput;
