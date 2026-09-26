import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { extOf, type OpenFile } from './types';

export type EditorHandle = { getDoc: () => string; focus: () => void };

type Props = {
  file: OpenFile;
  onDirty: (key: string, dirty: boolean) => void;
  onSave: (key: string, content: string) => void;
};

function languageFor(name: string): Extension {
  switch (extOf(name)) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'json': case 'jsonc': return json();
    case 'md': case 'markdown': return markdown();
    case 'css': case 'scss': case 'less': return css();
    case 'html': case 'htm': case 'vue': case 'svelte': return html();
    case 'py': return python();
    default: return [];
  }
}

// Tema do editor só com as variáveis globais; as cores de sintaxe são variáveis definidas em arquivos.css.
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '4px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg2)', border: 'none', minWidth: '48px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--active)' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': { outline: '1px solid var(--fg2)', backgroundColor: 'transparent' },
  '.cm-selectionMatch': { backgroundColor: 'var(--hover)' },
  '.cm-searchMatch': { backgroundColor: 'var(--active)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg2)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel input, .cm-panel button': { font: 'inherit', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--line)', borderRadius: '2px' },
  '.cm-tooltip': { backgroundColor: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--fg)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--active)', color: 'var(--fg)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg2)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--fg2)' },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--syn-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--syn-keyword)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.invalid, color: 'var(--git-conflict)' },
]);

/**
 * CodeMirror 6 com um EditorState por arquivo (histórico e cursor sobrevivem à troca de aba).
 * Mod-S salva via onSave; a sujeira é sinalizada por onDirty comparando com o último conteúdo salvo.
 */
const Editor = forwardRef<EditorHandle, Props>(function Editor({ file, onDirty, onSave }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, { state: EditorState; version: number }>());
  const current = useRef<{ key: string; version: number } | null>(null);
  const cb = useRef({ onDirty, onSave, file });
  cb.current = { onDirty, onSave, file };

  useImperativeHandle(ref, () => ({
    getDoc: () => view.current?.state.doc.toString() ?? cb.current.file.content,
    focus: () => view.current?.focus(),
  }), []);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (current.current && current.current.key === file.key && current.current.version === file.version) return;
    // guarda o estado do arquivo anterior
    if (current.current) states.current.set(current.current.key, { state: v.state, version: current.current.version });
    const cached = states.current.get(file.key);
    let state: EditorState;
    if (cached && cached.version === file.version) {
      state = cached.state;
    } else {
      const key = file.key;
      const saveKey = Prec.high(keymap.of([{
        key: 'Mod-s',
        run: (ev) => { cb.current.onSave(key, ev.state.doc.toString()); return true; },
      }]));
      const listener = EditorView.updateListener.of(u => {
        if (!u.docChanged) return;
        const saved = cb.current.file.key === key ? cb.current.file.content : null;
        const doc = u.state.doc;
        const dirty = saved === null ? true : doc.length !== saved.length || doc.toString() !== saved;
        cb.current.onDirty(key, dirty);
      });
      state = EditorState.create({
        doc: file.content,
        extensions: [basicSetup, keymap.of([indentWithTab]), languageFor(file.name), theme, syntaxHighlighting(highlight), saveKey, listener, EditorView.lineWrapping],
      });
    }
    v.setState(state);
    current.current = { key: file.key, version: file.version };
    states.current.set(file.key, { state, version: file.version });
  }, [file.key, file.version, file.content, file.name]);

  return <div ref={host} className="arq-cm" />;
});

export default Editor;
