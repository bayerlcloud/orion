export type EntryType = 'file' | 'dir' | 'symlink';
export type Entry = {
  name: string;
  type: EntryType;
  target?: 'file' | 'dir' | null;
  size: number;
  mtime: number;
  heavy?: boolean;
};

export type RootInfo = { id: number; slug: string; name: string; path: string; exists: boolean; git: boolean };

export type GitCode = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | '!' | '?';
export type GitStatus = {
  repo: boolean;
  files: Record<string, { code: GitCode; staged: boolean }>;
  folders: Record<string, { code: GitCode }>;
  ignored: string[];
};

export type Commit = { hash: string; author: string; date: number; subject: string };

export type ReadResult = { path: string; size: number; mtime: number; binary: boolean; large?: boolean; content?: string };

export type DirState = { entries: Entry[] | null; loading: boolean; error?: string; truncated?: boolean };

export type RowKind = 'root' | 'entry' | 'input';
export type Row = {
  key: string;
  rootId: number;
  rel: string;
  name: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
  kind: RowKind;
  entry?: Entry;
  heavy?: boolean;
  symlink?: boolean;
};

export type EditMode = 'rename' | 'newFile' | 'newDir';
export type Editing = { mode: EditMode; rootId: number; parentRel: string; rel?: string; initial: string };

export type FileKind = 'text' | 'binary' | 'image' | 'large';
export type OpenFile = {
  key: string;
  rootId: number;
  rel: string;
  name: string;
  kind: FileKind;
  content: string;
  mtime: number;
  size: number;
  dirty: boolean;
  preview: boolean;
  /** Incrementa quando o conteúdo é recarregado do disco (o editor recria o estado). */
  version: number;
  /** mtime que está no disco quando o PUT devolveu 409. */
  conflict?: number;
};

export const keyOf = (rootId: number, rel: string) => `${rootId}|${rel}`;
export function splitKey(key: string): { rootId: number; rel: string } {
  const i = key.indexOf('|');
  return { rootId: Number(key.slice(0, i)), rel: key.slice(i + 1) };
}
export const parentRel = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const baseName = (rel: string) => rel.split('/').pop() ?? rel;
export const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const isDirLike = (e: Entry) => e.type === 'dir' || (e.type === 'symlink' && e.target === 'dir');
export const isUnder = (rel: string, dir: string) => dir === '' ? true : rel === dir || rel.startsWith(dir + '/');

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
export function extOf(name: string): string {
  const base = baseName(name);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** Nome sem a extensão: o que o input de renomear seleciona ao abrir (explorerViewer.ts). */
export function stemLength(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

export const GIT_LABEL: Record<GitCode, string> = {
  M: 'modificado', A: 'adicionado', D: 'excluído', U: 'não rastreado', R: 'renomeado', C: 'copiado', '!': 'conflito', '?': 'desconhecido',
};

export function isIgnored(rel: string, ignored: string[] | undefined): boolean {
  if (!ignored?.length || !rel) return false;
  for (const g of ignored) if (rel === g || rel.startsWith(g + '/')) return true;
  return false;
}
