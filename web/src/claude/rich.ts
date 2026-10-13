// Formatação do campo de prompt. O rascunho é guardado em markdown (`**negrito**`, `*itálico*`,
// `- item`, `1. item`, `[texto](url)`); o DOM do campo é só a vista desse markdown.

export type Inline = { kind: 'text' | 'b' | 'i' | 'a'; text: string; href?: string };
export type Line = { list?: 'ul' | 'ol'; inl: Inline[] };

const INLINE = /\*\*(.+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index! > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'b', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'a', text: m[2], href: m[3] });
    else out.push({ kind: 'i', text: m[4] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}

export function parseMd(md: string): Line[] {
  return md.split('\n').map(l => {
    const ul = /^[-*•] (.*)$/.exec(l);
    if (ul) return { list: 'ul', inl: parseInline(ul[1]) };
    const ol = /^\d+[.)] (.*)$/.exec(l);
    if (ol) return { list: 'ol', inl: parseInline(ol[1]) };
    return { inl: parseInline(l) };
  });
}

/** O que vai para o Claude: link vira "texto (url)"; o resto do markdown segue como está. */
export function promptFromMd(md: string): string {
  return md.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => t === u ? u : `${t} (${u})`);
}

export function normalizeUrl(s: string): string | null {
  const t = s.trim();
  if (!t || /\s/.test(t)) return null;
  const u = /^https?:\/\//i.test(t) ? t : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) ? `https://${t}` : null;
  try { return u && new URL(u).protocol.startsWith('http') ? u : null; } catch { return null; }
}

function inlineEl(i: Inline): Node {
  if (i.kind === 'text') return document.createTextNode(i.text);
  const el = document.createElement(i.kind);
  el.textContent = i.text;
  if (i.kind === 'a') (el as HTMLAnchorElement).href = i.href!;
  return el;
}

/** Desenha o markdown no campo (só textContent e href http(s): sem HTML vindo de fora). */
export function renderMd(root: HTMLElement, md: string) {
  root.replaceChildren();
  if (!md) return;
  const lines = parseMd(md);
  let list: HTMLElement | null = null;
  lines.forEach((l, idx) => {
    if (l.list) {
      if (!list || list.tagName.toLowerCase() !== l.list) { list = document.createElement(l.list); root.appendChild(list); }
      const li = document.createElement('li');
      l.inl.forEach(i => li.appendChild(inlineEl(i)));
      if (!li.childNodes.length) li.appendChild(document.createElement('br'));
      list.appendChild(li);
      return;
    }
    list = null;
    l.inl.forEach(i => root.appendChild(inlineEl(i)));
    const next = lines[idx + 1];
    if (next && !next.list) root.appendChild(document.createElement('br'));
  });
  // Linha vazia no fim precisa de um <br> a mais para aparecer.
  if (lines.length > 1 && !lines[lines.length - 1].list && !lines[lines.length - 1].inl.length) root.appendChild(document.createElement('br'));
}

const BLOCK = new Set(['div', 'p', 'li', 'ul', 'ol']);

/** <br> que só fecha o bloco (o navegador põe um no fim de linha/bloco) não é quebra de linha. */
function trailingBr(br: Node): boolean {
  for (let n = br.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE && !n.textContent) continue;
    return n.nodeType === Node.ELEMENT_NODE && BLOCK.has((n as Element).tagName.toLowerCase());
  }
  return true;
}

/** Lê o campo de volta para markdown. */
export function serializeMd(root: HTMLElement): string {
  let out = '';
  // Quebra devida antes do próximo conteúdo (fim de bloco): só vira "\n" se algo vier depois.
  let pend = false;
  const emit = (s: string) => { if (pend) { out += '\n'; pend = false; } out += s; };
  const blockStart = () => { if (out && !out.endsWith('\n')) pend = true; };
  function inlineText(el: Node): string {
    const [o, p] = [out, pend]; out = ''; pend = false;
    el.childNodes.forEach(walk);
    const r = out; out = o; pend = p; return r;
  }
  const wrap = (mark: string, el: Node) => {
    const inner = inlineText(el);
    const m = /^(\s*)(.*?)(\s*)$/s.exec(inner)!;
    emit(m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner);
  };
  function walk(n: Node) {
    if (n.nodeType === Node.TEXT_NODE) { const t = (n.textContent ?? '').replace(/ /g, ' '); if (t) emit(t); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.contentEditable === 'false') return; // marcador de ditado
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') { if (!trailingBr(el)) emit('\n'); return; }
    if (tag === 'b' || tag === 'strong') return wrap('**', el);
    if (tag === 'i' || tag === 'em') return wrap('*', el);
    if (tag === 'a') {
      const href = normalizeUrl(el.getAttribute('href') ?? '');
      const t = inlineText(el);
      emit(href && t.trim() ? `[${t}](${href})` : t);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      let k = 0;
      el.childNodes.forEach(c => {
        if ((c as Element).tagName?.toLowerCase() !== 'li') return walk(c);
        blockStart(); emit(tag === 'ul' ? '- ' : `${++k}. `);
        c.childNodes.forEach(walk);
        pend = true;
      });
      return;
    }
    if (BLOCK.has(tag)) {
      blockStart();
      emit(''); // bloco vazio ainda é uma linha
      el.childNodes.forEach(walk);
      pend = true;
      return;
    }
    el.childNodes.forEach(walk);
  }
  root.childNodes.forEach(walk);
  return out;
}
