import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { copyText, filesApi } from './api';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { Chevron, IconClose, IconCollapseAll, IconEllipsis, IconLink, IconNewFile, IconNewFolder, IconRefresh, IconSearch } from './icons';
import {
  baseName, filterStaleExpandedKeys, isDirLike, isIgnored, isUnder, joinRel, keyOf, parentRel, splitKey, stemLength, validateNameClient,
  type DirState, type Editing, type GitCode, type GitStatus, type RootInfo, type Row,
} from './types';

/*
 * Árvore do explorer. Comportamento espelhado do VS Code (ver REFERENCIA.md): linhas de 22px, pastas
 * primeiro, clique simples abre em preview, duplo clique fixa, Enter abre, Left recolhe/vai ao pai,
 * Right expande/vai ao filho, F2 renomeia, Delete exclui, digitar pula para o item, input inline para
 * novo/renomear, drag & drop com confirmação, decorações do git com bubble nas pastas.
 */

export type Selection = { rootId: number; rel: string; name: string; isDir: boolean };
export type PathChange =
  | { kind: 'renamed'; rootId: number; from: string; to: string; isDir: boolean }
  | { kind: 'deleted'; rootId: number; rel: string; isDir: boolean };
export type ExplorerHandle = {
  refreshGit: (rootId?: number) => void;
  refresh: () => void;
  reveal: (rootId: number, rel: string) => Promise<void>;
};

type Props = {
  onOpen: (target: { rootId: number; rel: string; name: string }, opts: { pinned: boolean; preserveFocus?: boolean }) => void;
  onSelect: (sel: Selection | null) => void;
  onToast: (msg: string) => void;
  onPathChange: (c: PathChange) => void;
  onRoots: (roots: RootInfo[]) => void;
  onGit: (rootId: number, git: GitStatus) => void;
};

type Deco = { code?: GitCode; cls: string; dot?: boolean; title?: string };
const GIT_LABEL: Record<GitCode, string> = {
  M: 'modificado', A: 'adicionado', D: 'excluído', U: 'não rastreado', R: 'renomeado', C: 'copiado', '!': 'conflito', '?': 'desconhecido',
};

function decorate(row: Row, git: GitStatus | undefined): Deco {
  if (!git || row.kind === 'input' || row.kind === 'info') return { cls: '' };
  if (row.isDir) {
    const f = git.folders[row.rel];
    if (f) return { code: f.code, cls: `arq-git-${f.code === '!' ? 'conflict' : f.code}`, dot: true, title: 'contém itens alterados' };
  } else {
    const s = git.files[row.rel];
    if (s) return { code: s.code, cls: `arq-git-${s.code === '!' ? 'conflict' : s.code}`, title: `${GIT_LABEL[s.code]}${s.staged ? ' (staged)' : ''}` };
  }
  if (isIgnored(row.rel, git.ignored)) return { cls: 'arq-git-ignored', title: 'ignorado pelo git' };
  return { cls: '' };
}

const TYPEAHEAD_MS = 800;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '⌘' : 'Ctrl';

function buildRows(roots: RootInfo[], dirs: Record<string, DirState>, expanded: Set<string>, editing: Editing | null): Row[] {
  const rows: Row[] = [];
  const walk = (rootId: number, rel: string, depth: number) => {
    const dk = keyOf(rootId, rel);
    const d = dirs[dk];
    const newHere = !!editing && editing.mode !== 'rename' && editing.rootId === rootId && editing.parentRel === rel;
    let inputDone = false;
    const pushInput = () => {
      if (!newHere || inputDone) return;
      inputDone = true;
      rows.push({ key: `${dk}|__novo__`, rootId, rel, name: '', depth, isDir: editing!.mode === 'newDir', expanded: false, kind: 'input' });
    };
    if (!d || (d.loading && !d.entries)) {
      rows.push({ key: `${dk}|__info__`, rootId, rel, name: '', depth, isDir: false, expanded: false, kind: 'info', info: 'carregando…' });
      return;
    }
    if (d.error) rows.push({ key: `${dk}|__erro__`, rootId, rel, name: '', depth, isDir: false, expanded: false, kind: 'info', info: d.error });
    if (editing?.mode === 'newDir') pushInput();
    for (const e of d.entries ?? []) {
      const isDir = isDirLike(e);
      if (!isDir) pushInput();
      const erel = joinRel(rel, e.name);
      const ek = keyOf(rootId, erel);
      const exp = isDir && expanded.has(ek);
      rows.push({ key: ek, rootId, rel: erel, name: e.name, depth, isDir, expanded: exp, kind: 'entry', entry: e, heavy: e.heavy, symlink: e.type === 'symlink' });
      if (exp) walk(rootId, erel, depth + 1);
    }
    pushInput();
    if (d.truncated) rows.push({ key: `${dk}|__trunc__`, rootId, rel, name: '', depth, isDir: false, expanded: false, kind: 'info', info: 'lista cortada em 5000 itens' });
  };
  for (const r of roots) {
    const rk = keyOf(r.id, '');
    const exp = expanded.has(rk);
    rows.push({ key: rk, rootId: r.id, rel: '', name: r.name, depth: -1, isDir: true, expanded: exp, kind: 'root' });
    if (!exp) continue;
    if (!r.exists) {
      rows.push({ key: `${rk}|__info__`, rootId: r.id, rel: '', name: '', depth: 0, isDir: false, expanded: false, kind: 'info', info: `pasta não existe: ${r.path}` });
      continue;
    }
    walk(r.id, '', 0);
  }
  return rows;
}

/** Input inline (novo item / renomear), como o do explorer: seleciona o nome sem a extensão ao abrir. */
function InlineInput({ initial, isDir, siblings, self, onCommit, onCancel }: {
  initial: string; isDir: boolean; siblings: string[]; self?: string;
  onCommit: (v: string) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const err = validateNameClient(v, siblings, self);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, stemLength(initial, isDir));
  }, [initial, isDir]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && !err && v !== initial) onCommit(v);
    else onCancel();
  };
  return (
    <span className="arq-inline">
      <input
        ref={ref}
        className="arq-inline-input"
        value={v}
        spellCheck={false}
        autoComplete="off"
        onChange={e => setV(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); if (!err) finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        }}
        onBlur={() => finish(true)}
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onContextMenu={e => e.stopPropagation()}
      />
      {err && v !== initial && <span className="arq-inline-msg">{err}</span>}
    </span>
  );
}

const Explorer = forwardRef<ExplorerHandle, Props>(function Explorer(props, ref) {
  const cb = useRef(props);
  cb.current = props;

  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [rootsError, setRootsError] = useState('');
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // true depois que a preferência salva (GET /api/files/ui-state) foi aplicada — evita que o efeito
  // de salvar abaixo grave o estado inicial (vazio) por cima do que o usuário já tinha escolhido.
  const restoredRef = useRef(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [git, setGit] = useState<Record<number, GitStatus>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row | null; head?: boolean } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [find, setFind] = useState<{ q: string; server: boolean; results: { path: string; type: 'file' | 'dir' }[] | null; truncated: boolean; busy: boolean } | null>(null);
  const dragRow = useRef<Row | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const typeBuf = useRef({ s: '', t: 0 });
  const heavyOk = useRef(new Set<string>());
  const rowsRef = useRef<Row[]>([]);

  const rows = useMemo(() => buildRows(roots, dirs, expanded, editing), [roots, dirs, expanded, editing]);
  rowsRef.current = rows;

  // ---------- carregamento ----------

  const loadDir = useCallback(async (rootId: number, rel: string) => {
    const key = keyOf(rootId, rel);
    setDirs(d => ({ ...d, [key]: { entries: d[key]?.entries ?? null, loading: true } }));
    try {
      const r = await filesApi.list(rootId, rel);
      setDirs(d => ({ ...d, [key]: { entries: r.entries, loading: false, truncated: r.truncated } }));
      return r.entries;
    } catch (e) {
      setDirs(d => ({ ...d, [key]: { entries: d[key]?.entries ?? [], loading: false, error: (e as Error).message } }));
      return null;
    }
  }, []);

  const loadGit = useCallback(async (rootId: number) => {
    try {
      const g = await filesApi.gitStatus(rootId);
      setGit(s => ({ ...s, [rootId]: g }));
      cb.current.onGit(rootId, g);
    } catch { /* sem git ou sem permissão: fica sem decoração */ }
  }, []);

  const setExp = useCallback((key: string, on: boolean) => {
    setExpanded(s => {
      if (s.has(key) === on) return s;
      const n = new Set(s);
      if (on) n.add(key); else n.delete(key);
      return n;
    });
  }, []);

  const expandDir = useCallback(async (rootId: number, rel: string, name?: string, heavy?: boolean) => {
    const key = keyOf(rootId, rel);
    if (heavy && !heavyOk.current.has(key)) {
      if (!window.confirm(`"${name ?? rel}" pode ter milhares de entradas. Expandir mesmo assim?`)) return false;
      heavyOk.current.add(key);
    }
    setExp(key, true);
    if (!dirsRef.current[key]?.entries) await loadDir(rootId, rel);
    return true;
  }, [loadDir, setExp]);

  const refreshRoot = useCallback(async (rootId: number) => {
    const keys = [...expandedRef.current].filter(k => k.startsWith(`${rootId}|`) && dirsRef.current[k]);
    await Promise.all(keys.map(k => loadDir(rootId, k.slice(k.indexOf('|') + 1))));
    loadGit(rootId);
  }, [loadDir, loadGit]);

  const refreshAll = useCallback(async () => {
    try {
      const { roots: rs } = await filesApi.roots();
      setRoots(rs);
      setRootsError('');
      cb.current.onRoots(rs);
      await Promise.all(rs.map(r => refreshRoot(r.id)));
    } catch (e) {
      setRootsError((e as Error).message);
    }
  }, [refreshRoot]);

  useEffect(() => {
    let alive = true;
    filesApi.roots().then(({ roots: rs }) => {
      if (!alive) return;
      setRoots(rs);
      cb.current.onRoots(rs);
      for (const r of rs) if (r.exists) loadGit(r.id);
      // preferência de árvore expandida/colapsada (por usuário, persistida no banco — GET/PUT /api/files/ui-state)
      return filesApi.uiState.get().then(st => st.expanded_keys).catch(() => null).then(saved => {
        if (!alive) return;
        if (saved === null) {
          // nunca salvou: mantém o padrão de sempre — raízes abertas, subpastas fechadas
          for (const r of rs) { setExp(keyOf(r.id, ''), true); if (r.exists) loadDir(r.id, ''); }
        } else {
          const validIds = new Set(rs.map(r => r.id));
          for (const k of filterStaleExpandedKeys(saved, validIds)) {
            const { rootId, rel } = splitKey(k);
            void expandDir(rootId, rel);
          }
        }
        restoredRef.current = true;
      });
    }).catch(e => { if (alive) setRootsError((e as Error).message); });
    return () => { alive = false; };
  }, [expandDir, loadDir, loadGit, setExp]);

  // salva a preferência a cada mudança (best-effort, sem debounce — mesmo padrão do claude ui-state)
  useEffect(() => {
    if (!restoredRef.current) return;
    filesApi.uiState.put([...expanded]).catch(() => { /* melhor esforço: não incomoda o usuário */ });
  }, [expanded]);

  // git de tempos em tempos (as sessões do Claude mexem nos arquivos por fora)
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') for (const r of roots) if (r.exists) loadGit(r.id); };
    const id = window.setInterval(tick, 30_000);
    window.addEventListener('focus', tick);
    return () => { window.clearInterval(id); window.removeEventListener('focus', tick); };
  }, [roots, loadGit]);

  // ---------- seleção / foco ----------

  const rowOf = (key: string | null) => (key ? rowsRef.current.find(r => r.key === key) ?? null : null);

  const select = useCallback((row: Row | null) => {
    setSelectedKey(row?.key ?? null);
    setFocusKey(row?.key ?? null);
    cb.current.onSelect(row && row.kind !== 'info' && row.kind !== 'input'
      ? { rootId: row.rootId, rel: row.rel, name: row.name, isDir: row.isDir }
      : null);
  }, []);

  useEffect(() => {
    if (!focusKey || !treeRef.current) return;
    const el = treeRef.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusKey]);

  const moveFocus = (delta: number) => {
    const list = rowsRef.current;
    if (!list.length) return;
    const i = focusKey ? list.findIndex(r => r.key === focusKey) : -1;
    let j = i < 0 ? (delta > 0 ? 0 : list.length - 1) : i + delta;
    while (j >= 0 && j < list.length && (list[j].kind === 'input' || list[j].kind === 'info')) j += delta;
    if (j < 0 || j >= list.length) return;
    select(list[j]);
  };

  const toggleDir = (row: Row) => {
    if (row.expanded) setExp(row.key, false);
    else void expandDir(row.rootId, row.rel, row.name, row.heavy);
  };

  const focusParent = (row: Row) => {
    if (row.kind === 'root') return;
    const pk = row.depth === 0 ? keyOf(row.rootId, '') : keyOf(row.rootId, parentRel(row.rel));
    const p = rowOf(pk);
    if (p) select(p);
  };

  // ---------- ações ----------

  const rootOf = (id: number) => roots.find(r => r.id === id);
  const absPath = (rootId: number, rel: string) => {
    const r = rootOf(rootId);
    const base = r?.path ?? '';
    return rel ? `${base.replace(/\/$/, '')}/${rel}` : base;
  };
  const dirOfRow = (row: Row) => (row.isDir ? row.rel : parentRel(row.rel));

  const startNew = async (rootId: number, parentRelPath: string, mode: 'newFile' | 'newDir') => {
    if (parentRelPath) {
      const ok = await expandDir(rootId, parentRelPath, baseName(parentRelPath), isHeavyRel(parentRelPath));
      if (!ok) return;
    } else {
      setExp(keyOf(rootId, ''), true);
      if (!dirsRef.current[keyOf(rootId, '')]?.entries) await loadDir(rootId, '');
    }
    setEditing({ mode, rootId, parentRel: parentRelPath, initial: '' });
  };
  const isHeavyRel = (rel: string) => { const b = baseName(rel); return b === 'node_modules' || b === '.git'; };

  const startRename = (row: Row) => {
    if (row.kind !== 'entry') return;
    setEditing({ mode: 'rename', rootId: row.rootId, parentRel: parentRel(row.rel), rel: row.rel, initial: row.name });
  };

  const remapExpanded = (rootId: number, from: string, to: string) => {
    setExpanded(s => {
      const n = new Set<string>();
      for (const k of s) {
        const [rid, rel] = [Number(k.slice(0, k.indexOf('|'))), k.slice(k.indexOf('|') + 1)];
        if (rid === rootId && isUnder(rel, from)) n.add(keyOf(rootId, to + rel.slice(from.length)));
        else n.add(k);
      }
      return n;
    });
    setDirs(d => {
      const n: Record<string, DirState> = {};
      for (const [k, v] of Object.entries(d)) {
        const [rid, rel] = [Number(k.slice(0, k.indexOf('|'))), k.slice(k.indexOf('|') + 1)];
        if (rid === rootId && isUnder(rel, from)) n[keyOf(rootId, to + rel.slice(from.length))] = v;
        else n[k] = v;
      }
      return n;
    });
  };

  const commitEdit = async (value: string) => {
    const ed = editing;
    setEditing(null);
    if (!ed) return;
    const name = value.trim();
    if (!name) return;
    try {
      if (ed.mode === 'rename') {
        const from = ed.rel!;
        const to = joinRel(ed.parentRel, name);
        const wasDir = !!rowOf(keyOf(ed.rootId, from))?.isDir;
        await filesApi.rename(ed.rootId, from, to);
        if (wasDir) remapExpanded(ed.rootId, from, to);
        cb.current.onPathChange({ kind: 'renamed', rootId: ed.rootId, from, to, isDir: wasDir });
        await loadDir(ed.rootId, ed.parentRel);
        loadGit(ed.rootId);
        const nk = keyOf(ed.rootId, to);
        setSelectedKey(nk); setFocusKey(nk);
      } else {
        const rel = joinRel(ed.parentRel, name.replace(/^\/+|\/+$/g, ''));
        if (ed.mode === 'newDir') await filesApi.mkdir(ed.rootId, rel);
        else await filesApi.create(ed.rootId, rel);
        await loadDir(ed.rootId, ed.parentRel);
        loadGit(ed.rootId);
        // nome com "/" cria pastas intermediárias: expande até o item novo
        const parts = rel.slice(ed.parentRel ? ed.parentRel.length + 1 : 0).split('/');
        let cur = ed.parentRel;
        for (const p of parts.slice(0, -1)) { cur = joinRel(cur, p); await expandDir(ed.rootId, cur); }
        const nk = keyOf(ed.rootId, rel);
        setSelectedKey(nk); setFocusKey(nk);
        if (ed.mode === 'newFile') cb.current.onOpen({ rootId: ed.rootId, rel, name: baseName(rel) }, { pinned: true, preserveFocus: true });
      }
    } catch (e) {
      cb.current.onToast((e as Error).message);
    }
    treeRef.current?.focus();
  };

  const remove = async (row: Row) => {
    if (row.kind !== 'entry') return;
    const what = row.isDir ? `a pasta "${row.name}" e tudo dentro dela` : `"${row.name}"`;
    if (!window.confirm(`Excluir ${what}? Não vai para a lixeira.`)) return;
    try {
      await filesApi.remove(row.rootId, row.rel);
      cb.current.onPathChange({ kind: 'deleted', rootId: row.rootId, rel: row.rel, isDir: row.isDir });
      const list = rowsRef.current;
      const i = list.findIndex(r => r.key === row.key);
      const next = list.slice(i + 1).find(r => r.kind === 'entry' && !isUnder(r.rel, row.rel) && r.rootId === row.rootId)
        ?? list.slice(0, i).reverse().find(r => r.kind === 'entry' || r.kind === 'root');
      await loadDir(row.rootId, parentRel(row.rel));
      loadGit(row.rootId);
      select(next ?? null);
    } catch (e) {
      cb.current.onToast((e as Error).message);
    }
  };

  const moveTo = async (src: Row, destRootId: number, destRel: string) => {
    if (src.kind !== 'entry') return;
    if (src.rootId !== destRootId) { cb.current.onToast('só dá para mover dentro do mesmo projeto'); return; }
    if (parentRel(src.rel) === destRel) return;
    if (src.isDir && isUnder(destRel, src.rel)) { cb.current.onToast('não dá para mover uma pasta para dentro dela mesma'); return; }
    const destName = destRel ? baseName(destRel) : (rootOf(destRootId)?.name ?? 'raiz');
    if (!window.confirm(`Mover "${src.name}" para "${destName}"?`)) return;
    try {
      const r = await filesApi.move(src.rootId, src.rel, destRel);
      if (src.isDir) remapExpanded(src.rootId, src.rel, r.to);
      cb.current.onPathChange({ kind: 'renamed', rootId: src.rootId, from: src.rel, to: r.to, isDir: src.isDir });
      await Promise.all([loadDir(src.rootId, parentRel(src.rel)), expandDir(src.rootId, destRel).then(() => loadDir(src.rootId, destRel))]);
      loadGit(src.rootId);
      const nk = keyOf(src.rootId, r.to);
      setSelectedKey(nk); setFocusKey(nk);
    } catch (e) {
      cb.current.onToast((e as Error).message);
    }
  };

  const copyPath = async (row: Row, relative: boolean, claude = false) => {
    const text = relative ? row.rel : absPath(row.rootId, row.rel);
    const ok = await copyText(text);
    cb.current.onToast(!ok ? 'não deu para copiar' : claude ? 'caminho copiado; cole na sessão' : `copiado: ${text}`);
  };

  const collapseAll = (rootId?: number) => {
    setExpanded(s => new Set([...s].filter(k => k.endsWith('|') && (rootId === undefined || k.startsWith(`${rootId}|`)) || (rootId !== undefined && !k.startsWith(`${rootId}|`)))));
    setFocusKey(rootId !== undefined ? keyOf(rootId, '') : null);
  };

  const reveal = useCallback(async (rootId: number, rel: string) => {
    setExp(keyOf(rootId, ''), true);
    if (!dirsRef.current[keyOf(rootId, '')]?.entries) await loadDir(rootId, '');
    const parts = rel.split('/').filter(Boolean);
    parts.pop();
    let cur = '';
    for (const p of parts) {
      cur = joinRel(cur, p);
      const ok = await expandDir(rootId, cur, p, isHeavyRel(cur));
      if (!ok) return;
    }
    const k = keyOf(rootId, rel);
    setSelectedKey(k); setFocusKey(k);
  }, [expandDir, loadDir, setExp]);

  useImperativeHandle(ref, () => ({
    refreshGit: (rootId?: number) => { for (const r of roots) if (rootId === undefined || r.id === rootId) loadGit(r.id); },
    refresh: () => { void refreshAll(); },
    reveal,
  }), [roots, loadGit, refreshAll, reveal]);

  // ---------- teclado ----------

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const row = rowOf(focusKey);
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveFocus(1); return;
      case 'ArrowUp': e.preventDefault(); moveFocus(-1); return;
      case 'Home': e.preventDefault(); { const f = rowsRef.current[0]; if (f) select(f); } return;
      case 'End': e.preventDefault(); { const l = [...rowsRef.current].reverse().find(r => r.kind !== 'info' && r.kind !== 'input'); if (l) select(l); } return;
      case 'PageDown': e.preventDefault(); moveFocus(20); return;
      case 'PageUp': e.preventDefault(); moveFocus(-20); return;
      case 'ArrowLeft':
        e.preventDefault();
        if (!row) return;
        if (mod) { collapseAll(row.rootId); return; }
        if (row.isDir && row.expanded) setExp(row.key, false);
        else focusParent(row);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (!row || !row.isDir) return;
        if (!row.expanded) { toggleDir(row); return; }
        { const list = rowsRef.current; const i = list.findIndex(r => r.key === row.key); const child = list[i + 1]; if (child && child.kind === 'entry' && child.depth === row.depth + 1) select(child); }
        return;
      case 'Enter':
        e.preventDefault();
        if (!row) return;
        if (row.isDir) toggleDir(row);
        else cb.current.onOpen({ rootId: row.rootId, rel: row.rel, name: row.name }, { pinned: true });
        return;
      case ' ':
        e.preventDefault();
        if (!row) return;
        if (row.isDir) toggleDir(row);
        else cb.current.onOpen({ rootId: row.rootId, rel: row.rel, name: row.name }, { pinned: false, preserveFocus: true });
        return;
      case 'F2':
        e.preventDefault();
        if (row) startRename(row);
        return;
      case 'Delete':
      case 'Backspace':
        if (e.key === 'Backspace' && !mod) return;
        e.preventDefault();
        if (row) void remove(row);
        return;
      case 'Escape':
        e.preventDefault();
        if (find) setFind(null);
        else select(null);
        return;
      case 'F3':
        e.preventDefault();
        setFind(f => f ?? { q: '', server: false, results: null, truncated: false, busy: false });
        return;
    }
    if (mod && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (row && row.kind !== 'info' && row.kind !== 'input') void copyPath(row, e.shiftKey);
      return;
    }
    if (mod && e.altKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF')) {
      e.preventDefault();
      setFind(f => f ?? { q: '', server: false, results: null, truncated: false, busy: false });
      return;
    }
    if (mod || e.altKey || e.key.length !== 1) return;
    // navegação por digitação: pula para o próximo item cujo nome começa com o que foi digitado
    e.preventDefault();
    const now = Date.now();
    const buf = now - typeBuf.current.t < TYPEAHEAD_MS ? typeBuf.current.s + e.key : e.key;
    typeBuf.current = { s: buf, t: now };
    const list = rowsRef.current;
    const start = focusKey ? list.findIndex(r => r.key === focusKey) : -1;
    const from = buf.length > 1 ? start : start + 1;
    const q = buf.toLowerCase();
    for (let n = 0; n < list.length; n++) {
      const r = list[(from + n + list.length) % list.length];
      if (r.kind === 'entry' && r.name.toLowerCase().startsWith(q)) { select(r); return; }
    }
  };

  // ---------- menus ----------

  const openMenu = (e: React.MouseEvent, row: Row | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (row) select(row);
    setMenu({ x: e.clientX, y: e.clientY, row });
  };

  const menuItems = (row: Row | null): MenuItem[] => {
    const r = row ?? (roots[0] ? rowsRef.current[0] : null);
    if (!r) return [{ label: 'Atualizar', onClick: () => void refreshAll() }];
    const dir = dirOfRow(r);
    const isRoot = r.kind === 'root';
    return [
      { label: 'Novo arquivo…', onClick: () => void startNew(r.rootId, dir, 'newFile') },
      { label: 'Nova pasta…', onClick: () => void startNew(r.rootId, dir, 'newDir') },
      { sep: true },
      { label: 'Copiar caminho', hint: `${modKey}+C`, onClick: () => void copyPath(r, false) },
      { label: 'Copiar caminho relativo', hint: `${modKey}+Shift+C`, disabled: isRoot, onClick: () => void copyPath(r, true) },
      { label: 'Abrir no Claude', onClick: () => void copyPath(r, false, true) },
      { sep: true },
      { label: 'Renomear…', hint: 'F2', disabled: isRoot, onClick: () => startRename(r) },
      { label: 'Excluir', hint: isMac ? '⌘⌫' : 'Delete', disabled: isRoot, onClick: () => void remove(r) },
      { sep: true },
      { label: 'Atualizar', onClick: () => void refreshRoot(r.rootId) },
      ...(isRoot ? [{ label: 'Recolher tudo', onClick: () => collapseAll(r.rootId) } as MenuItem] : []),
    ];
  };

  const headMenuItems = (): MenuItem[] => [
    { label: 'Recolher tudo', hint: `${modKey}+←`, onClick: () => collapseAll() },
    { label: 'Atualizar', onClick: () => void refreshAll() },
    { sep: true },
    { label: 'Localizar…', hint: 'F3', onClick: () => setFind(f => f ?? { q: '', server: false, results: null, truncated: false, busy: false }) },
  ];

  // ---------- localizar ----------

  const findRootId = () => rowOf(focusKey)?.rootId ?? roots[0]?.id;
  const runServerFind = async (q: string) => {
    const rid = findRootId();
    if (rid === undefined || !q.trim()) return;
    setFind(f => f && { ...f, busy: true });
    try {
      const r = await filesApi.search(rid, q.trim());
      setFind(f => f && { ...f, results: r.matches, truncated: r.truncated, busy: false });
    } catch (e) {
      cb.current.onToast((e as Error).message);
      setFind(f => f && { ...f, busy: false });
    }
  };
  const findQ = find?.q.trim().toLowerCase() ?? '';
  const matchesFind = (row: Row) => !findQ || find?.server || row.kind !== 'entry' || row.name.toLowerCase().includes(findQ);

  // ---------- drag & drop ----------

  const dropTargetOf = (row: Row): { key: string; rootId: number; rel: string } | null => {
    if (row.kind === 'root') return { key: row.key, rootId: row.rootId, rel: '' };
    if (row.kind !== 'entry') return null;
    const rel = dirOfRow(row);
    return { key: keyOf(row.rootId, rel), rootId: row.rootId, rel };
  };
  const onDragOverRow = (e: React.DragEvent, row: Row) => {
    const src = dragRow.current;
    if (!src) return;
    const t = dropTargetOf(row);
    if (!t || t.rootId !== src.rootId) return;
    if (src.isDir && isUnder(t.rel, src.rel)) return;
    if (parentRel(src.rel) === t.rel) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropKey !== t.key) setDropKey(t.key);
  };
  const onDropRow = (e: React.DragEvent, row: Row) => {
    e.preventDefault();
    const src = dragRow.current;
    dragRow.current = null;
    setDropKey(null);
    const t = dropTargetOf(row);
    if (src && t) void moveTo(src, t.rootId, t.rel);
  };

  // ---------- render ----------

  const siblingsOf = (rootId: number, rel: string) => (dirsRef.current[keyOf(rootId, rel)]?.entries ?? []).map(e => e.name);

  const renderRoot = (row: Row) => {
    const root = rootOf(row.rootId);
    const deco = decorate({ ...row, kind: 'entry' }, git[row.rootId]);
    const cls = ['arq-section-head', 'arq-row', focusKey === row.key ? 'is-focus' : '', selectedKey === row.key ? 'is-selected' : '', dropKey === row.key ? 'is-drop' : ''].join(' ');
    return (
      <div
        key={row.key}
        data-key={row.key}
        className={cls}
        title={root?.path}
        onClick={() => { select(row); toggleDir(row); }}
        onContextMenu={e => openMenu(e, row)}
        onDragOver={e => onDragOverRow(e, row)}
        onDragLeave={() => setDropKey(k => (k === row.key ? null : k))}
        onDrop={e => onDropRow(e, row)}
      >
        <span className="arq-twistie"><Chevron open={row.expanded} /></span>
        <span className={`arq-section-title ${deco.cls}`}>{row.name}</span>
        <span className="arq-actions" onClick={e => e.stopPropagation()}>
          <button type="button" className="arq-icon" title="Novo arquivo…" onClick={() => void startNew(row.rootId, focusedDirIn(row.rootId), 'newFile')}><IconNewFile /></button>
          <button type="button" className="arq-icon" title="Nova pasta…" onClick={() => void startNew(row.rootId, focusedDirIn(row.rootId), 'newDir')}><IconNewFolder /></button>
          <button type="button" className="arq-icon" title="Atualizar" onClick={() => void refreshRoot(row.rootId)}><IconRefresh /></button>
          <button type="button" className="arq-icon" title="Recolher pastas" onClick={() => collapseAll(row.rootId)}><IconCollapseAll /></button>
        </span>
        {deco.dot && <span className={`arq-dot ${deco.cls}`} title={deco.title}>●</span>}
        {root && !root.git && root.exists && <span className="arq-hint" title="sem repositório git">sem git</span>}
      </div>
    );
  };
  /** Pasta onde os ícones do cabeçalho criam itens: a da linha focada (como no VS Code), senão a raiz. */
  const focusedDirIn = (rootId: number) => {
    const r = rowOf(focusKey);
    return r && r.rootId === rootId && r.kind === 'entry' ? dirOfRow(r) : '';
  };

  const renderEntry = (row: Row) => {
    const deco = decorate(row, git[row.rootId]);
    const isRenaming = editing?.mode === 'rename' && editing.rootId === row.rootId && editing.rel === row.rel;
    const dim = !matchesFind(row);
    const cls = ['arq-row', 'arq-entry', focusKey === row.key ? 'is-focus' : '', selectedKey === row.key ? 'is-selected' : '',
      dropKey === row.key ? 'is-drop' : '', dim ? 'is-dim' : '', deco.code === 'D' ? 'is-strike' : ''].join(' ');
    return (
      <div
        key={row.key}
        data-key={row.key}
        className={cls}
        title={deco.title ? `${row.rel} — ${deco.title}` : row.rel}
        draggable={!isRenaming}
        onClick={e => {
          select(row);
          if (row.isDir) toggleDir(row);
          else cb.current.onOpen({ rootId: row.rootId, rel: row.rel, name: row.name }, { pinned: e.detail > 1, preserveFocus: true });
        }}
        onDoubleClick={() => { if (!row.isDir) cb.current.onOpen({ rootId: row.rootId, rel: row.rel, name: row.name }, { pinned: true }); }}
        onContextMenu={e => openMenu(e, row)}
        onDragStart={e => { dragRow.current = row; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', absPath(row.rootId, row.rel)); }}
        onDragEnd={() => { dragRow.current = null; setDropKey(null); }}
        onDragOver={e => onDragOverRow(e, row)}
        onDragLeave={() => setDropKey(k => (k === keyOf(row.rootId, dirOfRow(row)) && !row.isDir ? k : k === row.key ? null : k))}
        onDrop={e => onDropRow(e, row)}
      >
        {Array.from({ length: row.depth }, (_, i) => <span key={i} className="arq-guide" />)}
        <span className="arq-twistie" onClick={e => { if (row.isDir) { e.stopPropagation(); setFocusKey(row.key); toggleDir(row); } }}>
          {row.isDir && <Chevron open={row.expanded} />}
        </span>
        {isRenaming
          ? <InlineInput initial={row.name} isDir={row.isDir} siblings={siblingsOf(row.rootId, parentRel(row.rel))} self={row.name} onCommit={v => void commitEdit(v)} onCancel={() => { setEditing(null); treeRef.current?.focus(); }} />
          : <span className={`arq-label ${deco.cls}`}>{row.name}</span>}
        {row.symlink && <span className="arq-sym" title="link simbólico"><IconLink /></span>}
        {row.heavy && !row.expanded && <span className="arq-hint">pesado</span>}
        {deco.dot
          ? <span className={`arq-dot ${deco.cls}`} title={deco.title}>●</span>
          : deco.code ? <span className={`arq-badge ${deco.cls}`} title={deco.title}>{deco.code}</span> : null}
      </div>
    );
  };

  const renderInput = (row: Row) => (
    <div key={row.key} data-key={row.key} className="arq-row arq-entry is-editing">
      {Array.from({ length: row.depth }, (_, i) => <span key={i} className="arq-guide" />)}
      <span className="arq-twistie">{row.isDir && <Chevron open={false} />}</span>
      <InlineInput initial="" isDir={row.isDir} siblings={siblingsOf(row.rootId, row.rel)} onCommit={v => void commitEdit(v)} onCancel={() => { setEditing(null); treeRef.current?.focus(); }} />
    </div>
  );

  const renderInfo = (row: Row) => (
    <div key={row.key} className="arq-row arq-info">
      {Array.from({ length: row.depth }, (_, i) => <span key={i} className="arq-guide" />)}
      <span className="arq-twistie" />
      <span className="arq-label">{row.info}</span>
    </div>
  );

  const firstRoot = roots[0];

  return (
    <div className="arq-explorer">
      <div className="arq-head">
        <span className="arq-head-title">EXPLORER</span>
        <button type="button" className="arq-icon" title="Mais ações…" onClick={e => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2, row: null, head: true }); }}><IconEllipsis /></button>
      </div>
      {find && (
        <div className="arq-find">
          <span className="arq-find-ico"><IconSearch /></span>
          <input
            autoFocus
            className="arq-find-input"
            placeholder={find.server ? 'nome do arquivo no projeto…' : 'digite para filtrar'}
            value={find.q}
            onChange={e => setFind(f => f && { ...f, q: e.target.value, results: f.server ? f.results : null })}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Escape') { setFind(null); treeRef.current?.focus(); }
              else if (e.key === 'Enter') { if (find.server) void runServerFind(find.q); else treeRef.current?.focus(); }
              else if (e.key === 'ArrowDown') { treeRef.current?.focus(); moveFocus(1); }
            }}
          />
          <button type="button" className={`arq-find-toggle${find.server ? ' is-on' : ''}`} title="buscar no projeto inteiro (servidor)"
            onClick={() => setFind(f => f && { ...f, server: !f.server, results: null })}>projeto</button>
          <button type="button" className="arq-icon" title="fechar" onClick={() => { setFind(null); treeRef.current?.focus(); }}><IconClose /></button>
        </div>
      )}
      <div
        ref={treeRef}
        className="arq-tree"
        tabIndex={0}
        role="tree"
        onKeyDown={onKey}
        onContextMenu={e => openMenu(e, null)}
        onDragOver={e => { if (dragRow.current && firstRoot && dragRow.current.rootId === firstRoot.id && parentRel(dragRow.current.rel) !== '') { e.preventDefault(); setDropKey(keyOf(firstRoot.id, '')); } }}
        onDrop={e => { const src = dragRow.current; dragRow.current = null; setDropKey(null); if (src && firstRoot) { e.preventDefault(); void moveTo(src, firstRoot.id, ''); } }}
      >
        {rootsError && <div className="arq-empty">{rootsError}</div>}
        {!rootsError && !roots.length && <div className="arq-empty">carregando…</div>}
        {find?.server && find.results
          ? (
            <div className="arq-results">
              {find.busy && <div className="arq-empty">buscando…</div>}
              {!find.results.length && !find.busy && <div className="arq-empty">nada com "{find.q}"</div>}
              {find.results.map(m => (
                <div key={m.path} className="arq-row arq-result" title={m.path}
                  onClick={() => { const rid = findRootId(); if (rid === undefined) return; void reveal(rid, m.path).then(() => { if (m.type === 'file') cb.current.onOpen({ rootId: rid, rel: m.path, name: baseName(m.path) }, { pinned: false, preserveFocus: true }); }); }}>
                  <span className="arq-twistie" />
                  <span className="arq-label">{baseName(m.path)}</span>
                  <span className="arq-result-dir">{parentRel(m.path)}</span>
                </div>
              ))}
              {find.truncated && <div className="arq-empty">lista cortada em 200</div>}
            </div>
          )
          : rows.map(row => row.kind === 'root' ? renderRoot(row) : row.kind === 'input' ? renderInput(row) : row.kind === 'info' ? renderInfo(row) : renderEntry(row))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.head ? headMenuItems() : menuItems(menu.row)} onClose={() => setMenu(null)} />}
    </div>
  );
});

export default Explorer;
