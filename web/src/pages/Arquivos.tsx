import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../api';
import { filesApi } from '../files/api';
import type { EditorHandle } from '../files/Editor';
import Explorer, { type ExplorerHandle, type PathChange, type Selection } from '../files/Explorer';
import Tabs from '../files/Tabs';
import Timeline from '../files/Timeline';
import { Chevron } from '../files/icons';
import { GIT_LABEL, IMAGE_EXT, baseName, extOf, isUnder, keyOf, type GitStatus, type OpenFile, type RootInfo } from '../files/types';
import { formatBytes } from './driveUtils';
import './arquivos.css';

// CodeMirror só entra no bundle quando um arquivo de texto abre.
const Editor = lazy(() => import('../files/Editor'));

/**
 * Página Arquivos: explorer à esquerda (300px), abas + CodeMirror à direita, barra de status embaixo.
 * A árvore vive em files/Explorer.tsx; aqui ficam as abas, o editor, o salvar e a barra.
 */
export default function Arquivos(_props: { user: User }) {
  const explorer = useRef<ExplorerHandle>(null);
  const editor = useRef<EditorHandle>(null);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [git, setGit] = useState<Record<number, GitStatus>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const toastTimer = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const patch = useCallback((key: string, p: Partial<OpenFile> | ((f: OpenFile) => Partial<OpenFile>)) => {
    setFiles(fs => {
      let changed = false;
      const next = fs.map(f => {
        if (f.key !== key) return f;
        const delta = typeof p === 'function' ? p(f) : p;
        if (!Object.keys(delta).length) return f;
        changed = true;
        return { ...f, ...delta };
      });
      return changed ? next : fs;
    });
  }, []);

  // ---------- abrir / fechar ----------

  const openFile = useCallback(async (t: { rootId: number; rel: string; name: string }, opts: { pinned: boolean; preserveFocus?: boolean }) => {
    const key = keyOf(t.rootId, t.rel);
    const existing = filesRef.current.find(f => f.key === key);
    if (existing) {
      setActive(key);
      if (opts.pinned && existing.preview) patch(key, { preview: false });
      if (!opts.preserveFocus) window.setTimeout(() => editor.current?.focus(), 0);
      return;
    }
    let of: OpenFile;
    try {
      const r = await filesApi.read(t.rootId, t.rel);
      const kind: OpenFile['kind'] = IMAGE_EXT.has(extOf(t.name)) ? 'image' : r.binary ? 'binary' : r.large ? 'large' : 'text';
      of = { key, rootId: t.rootId, rel: t.rel, name: t.name, kind, content: r.content ?? '', mtime: r.mtime, size: r.size, dirty: false, preview: !opts.pinned, version: 0 };
    } catch (e) {
      showToast((e as Error).message);
      return;
    }
    setFiles(fs => {
      if (fs.some(f => f.key === key)) return fs;
      const i = fs.findIndex(f => f.preview && !f.dirty);
      if (!opts.pinned && i >= 0) { const copy = [...fs]; copy[i] = of; return copy; }
      if (opts.pinned && i >= 0 && fs[i].key !== key) { const copy = [...fs]; copy[i] = of; return copy; }
      return [...fs, of];
    });
    setActive(key);
    if (!opts.preserveFocus) window.setTimeout(() => editor.current?.focus(), 0);
  }, [patch, showToast]);

  const closeFile = useCallback((key: string) => {
    const f = filesRef.current.find(x => x.key === key);
    if (!f) return;
    if (f.dirty && !window.confirm(`Descartar as alterações em "${f.name}"?`)) return;
    setFiles(fs => {
      const i = fs.findIndex(x => x.key === key);
      const next = fs.filter(x => x.key !== key);
      if (activeRef.current === key) setActive(next[Math.min(i, next.length - 1)]?.key ?? null);
      return next;
    });
  }, []);

  // ---------- salvar ----------

  const save = useCallback(async (key: string, content: string, force = false) => {
    const f = filesRef.current.find(x => x.key === key);
    if (!f || f.kind !== 'text') return;
    try {
      const r = await filesApi.write(f.rootId, f.rel, content, force ? undefined : f.mtime);
      if (!r.ok) {
        patch(key, { conflict: r.mtime });
        showToast('o arquivo mudou no disco — veja o aviso acima do editor');
        return;
      }
      patch(key, { content, mtime: r.mtime, size: r.size, dirty: false, conflict: undefined, preview: false });
      setSavedAt(s => ({ ...s, [key]: Date.now() }));
      explorer.current?.refreshGit(f.rootId);
    } catch (e) {
      showToast(`não salvou: ${(e as Error).message}`);
    }
  }, [patch, showToast]);

  const reload = useCallback(async (key: string) => {
    const f = filesRef.current.find(x => x.key === key);
    if (!f) return;
    try {
      const r = await filesApi.read(f.rootId, f.rel);
      patch(key, fx => ({ content: r.content ?? '', mtime: r.mtime, size: r.size, dirty: false, conflict: undefined, version: fx.version + 1 }));
    } catch (e) {
      showToast((e as Error).message);
    }
  }, [patch, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const key = activeRef.current;
        if (key) void save(key, editor.current?.getDoc() ?? filesRef.current.find(f => f.key === key)?.content ?? '');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // ---------- caminhos mudaram na árvore ----------

  const onPathChange = useCallback((c: PathChange) => {
    if (c.kind === 'deleted') {
      setFiles(fs => {
        const gone = fs.filter(f => f.rootId === c.rootId && (c.isDir ? isUnder(f.rel, c.rel) : f.rel === c.rel));
        if (!gone.length) return fs;
        const next = fs.filter(f => !gone.includes(f));
        if (activeRef.current && gone.some(g => g.key === activeRef.current)) setActive(next[0]?.key ?? null);
        return next;
      });
      return;
    }
    setFiles(fs => fs.map(f => {
      if (f.rootId !== c.rootId) return f;
      const hit = c.isDir ? isUnder(f.rel, c.from) : f.rel === c.from;
      if (!hit) return f;
      const rel = c.to + f.rel.slice(c.from.length);
      const key = keyOf(f.rootId, rel);
      if (activeRef.current === f.key) setActive(key);
      return { ...f, rel, key, name: baseName(rel) };
    }));
  }, []);

  // ---------- render ----------

  const current = files.find(f => f.key === active) ?? null;
  const statusRootId = current?.rootId ?? selection?.rootId ?? null;
  const statusRel = current?.rel ?? selection?.rel ?? '';
  const statusRoot = roots.find(r => r.id === statusRootId);
  const statusGit = statusRootId !== null ? git[statusRootId] : undefined;
  const statusCode = statusGit && statusRel ? statusGit.files[statusRel] : undefined;
  const saved = current ? savedAt[current.key] : undefined;
  const timelineTarget = selection && !selection.isDir ? selection : current ? { rootId: current.rootId, rel: current.rel } : null;

  return (
    <div className="arq">
      <aside className="arq-side">
        <Explorer
          ref={explorer}
          onOpen={openFile}
          onSelect={setSelection}
          onToast={showToast}
          onPathChange={onPathChange}
          onRoots={setRoots}
          onGit={(rootId, g) => setGit(s => ({ ...s, [rootId]: g }))}
        />
        <div className={`arq-section${outlineOpen ? ' is-open' : ''}`}>
          <div className="arq-row arq-section-head" onClick={() => setOutlineOpen(o => !o)}>
            <span className="arq-twistie"><Chevron open={outlineOpen} /></span>
            <span className="arq-section-title">Outline</span>
          </div>
          {outlineOpen && <div className="arq-section-body arq-empty">Em breve</div>}
        </div>
        <div className={`arq-section${timelineOpen ? ' is-open' : ''}`}>
          <div className="arq-row arq-section-head" onClick={() => setTimelineOpen(o => !o)}>
            <span className="arq-twistie"><Chevron open={timelineOpen} /></span>
            <span className="arq-section-title">Timeline</span>
            {timelineTarget && <span className="arq-hint">{baseName(timelineTarget.rel)}</span>}
          </div>
          <Timeline open={timelineOpen} rootId={timelineTarget?.rootId ?? null} rel={timelineTarget?.rel ?? null} />
        </div>
      </aside>

      <section className="arq-main">
        <Tabs
          files={files}
          active={active}
          onActivate={k => { setActive(k); window.setTimeout(() => editor.current?.focus(), 0); }}
          onClose={closeFile}
          onPin={k => patch(k, { preview: false })}
        />
        <div className="arq-editor">
          {!current && (
            <div className="arq-blank">
              <div>Selecione um arquivo na árvore.</div>
              <div className="small">Enter abre · F2 renomeia · Delete exclui · <kbd>⌘/Ctrl</kbd>+<kbd>S</kbd> salva · F3 localiza</div>
            </div>
          )}
          {current?.conflict !== undefined && (
            <div className="arq-conflict">
              <span>O arquivo mudou no disco desde que foi aberto.</span>
              <button type="button" onClick={() => void save(current.key, editor.current?.getDoc() ?? current.content, true)}>Sobrescrever</button>
              <button type="button" onClick={() => void reload(current.key)}>Recarregar do disco</button>
            </div>
          )}
          {current?.kind === 'text' && (
            <Suspense fallback={<div className="arq-blank">carregando editor…</div>}>
              <Editor
                ref={editor}
                file={current}
                onDirty={(k, d) => patch(k, f => (f.dirty === d ? {} : { dirty: d, preview: d ? false : f.preview }))}
                onSave={(k, c) => void save(k, c)}
              />
            </Suspense>
          )}
          {current?.kind === 'image' && (
            <div className="arq-image"><img src={filesApi.rawUrl(current.rootId, current.rel)} alt={current.name} /></div>
          )}
          {current?.kind === 'binary' && (
            <div className="arq-blank"><div>arquivo binário</div><div className="small">{current.name} · {formatBytes(current.size)}</div></div>
          )}
          {current?.kind === 'large' && (
            <div className="arq-blank">
              <div>arquivo grande demais para o editor ({formatBytes(current.size)})</div>
              <a href={filesApi.rawUrl(current.rootId, current.rel)} target="_blank" rel="noreferrer">abrir o conteúdo bruto</a>
            </div>
          )}
        </div>
      </section>

      <footer className="arq-status">
        <span title={statusRoot?.path}>{statusRoot ? statusRoot.name : roots.length ? '—' : 'sem projetos'}</span>
        <span className="arq-status-path" title={statusRel}>{statusRel || (statusRoot ? '/' : '')}</span>
        {statusCode && <span className={`arq-git-${statusCode.code === '!' ? 'conflict' : statusCode.code}`}>{statusCode.code} · {GIT_LABEL[statusCode.code]}{statusCode.staged ? ' (staged)' : ''}</span>}
        {statusGit && !statusGit.repo && <span>sem git</span>}
        {current?.kind === 'text' && <span className={current.dirty ? 'is-dirty' : ''}>{current.dirty ? 'alterado' : `${current.content.split('\n').length} linhas · ${formatBytes(current.size)}`}</span>}
        <span>{saved ? `salvo há ${Math.max(0, Math.round((Date.now() - saved) / 1000))}s` : ''}</span>
      </footer>

      {toast && <div className="arq-toast" role="status">{toast}</div>}
    </div>
  );
}
