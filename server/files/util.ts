import path from 'node:path';

/** Helpers puros da página Arquivos (sem I/O), cobertos por tests/files.test.ts. */

export type EntryType = 'file' | 'dir' | 'symlink';
export type Entry = {
  name: string;
  type: EntryType;
  /** Para symlink: o que ele aponta (null = alvo quebrado). */
  target?: 'file' | 'dir' | null;
  size: number;
  /** mtime em ms, inteiro. */
  mtime: number;
  /** node_modules / .git: a interface avisa antes de expandir. */
  heavy?: boolean;
};

export type GitCode = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | '!' | '?';
export type GitEntry = { code: GitCode; staged: boolean };
export type GitStatusMap = Record<string, GitEntry>;

// ---------- caminhos ----------

/**
 * Resolve `rel` dentro de `rootPath` e devolve o caminho absoluto normalizado, ou null
 * quando o resultado sai da raiz (`..`, caminho absoluto, byte nulo, raiz vazia).
 * Não toca o disco: symlinks são tratados pelas rotas com realpath (ver routes/files.ts).
 */
export function resolveInside(rootPath: string, rel: string): string | null {
  if (typeof rootPath !== 'string' || !rootPath.trim()) return null;
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const root = path.resolve(rootPath);
  // Caminho absoluto no parâmetro nunca é aceito, mesmo que apontasse para dentro da raiz.
  if (path.isAbsolute(rel) || rel.startsWith('\\')) return null;
  const abs = path.resolve(root, rel);
  return isInside(root, abs) ? abs : null;
}

/** `abs` é a própria raiz ou um descendente dela (comparação por segmentos, não por prefixo de string). */
export function isInside(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  const rel = path.relative(r, a);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Caminho relativo à raiz, sempre com `/` (é o que a interface e o git usam). */
export function relativeInside(root: string, abs: string): string {
  return path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join('/');
}

/** Junta caminho relativo + nome sem produzir `./` nem barras duplas. */
export function joinRel(dir: string, name: string): string {
  const d = (dir ?? '').replace(/^\/+|\/+$/g, '');
  return d ? `${d}/${name}` : name;
}

/**
 * Validação de nome de arquivo/pasta no espírito de `validateFileName` (fileActions.ts do VS Code):
 * vazio, só espaço, `.`/`..`, barra, byte nulo ou caractere de controle → mensagem de erro; senão null.
 */
export function validateName(name: string): string | null {
  if (typeof name !== 'string' || !name.length || /^\s+$/.test(name)) return 'informe um nome';
  if (name === '.' || name === '..') return `"${name}" não é um nome válido`;
  if (/[\\/]/.test(name)) return 'o nome não pode ter barra';
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(name)) return 'o nome tem caractere inválido';
  if (name.length > 255) return 'nome longo demais';
  return null;
}

/** Mesmo que validateName, mas aceita `a/b/c` (cria pastas intermediárias, como o VS Code). */
export function validateRelName(rel: string): string | null {
  if (typeof rel !== 'string' || !rel.length) return 'informe um nome';
  if (rel.startsWith('/') || rel.startsWith('\\')) return 'o nome não pode começar com barra';
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return 'informe um nome';
  for (const p of parts) {
    const err = validateName(p);
    if (err) return err;
  }
  return null;
}

export const HEAVY_DIRS = new Set(['node_modules', '.git']);
export function isHeavy(name: string): boolean {
  return HEAVY_DIRS.has(name);
}

// ---------- ordenação ----------

// Igual ao explorer: Intl.Collator numérico (a2 < a10), sem distinguir caixa; empate resolvido pelo
// comprimento e por fim pela ordem de código, para a ordem ser estável.
// Referência: compareFileNamesDefault em src/vs/base/common/comparers.ts (VS Code, MIT).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a: string, b: string): number {
  const r = collator.compare(a, b);
  if (r !== 0) return r;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isDirLike(e: Pick<Entry, 'type' | 'target'>): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.target === 'dir');
}

/** `explorer.sortOrder = default`: pastas primeiro, depois arquivos, ambos por nome natural. */
export function sortEntries<T extends Pick<Entry, 'name' | 'type' | 'target'>>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const da = isDirLike(a);
    const db = isDirLike(b);
    if (da !== db) return da ? -1 : 1;
    return compareNames(a.name, b.name);
  });
}

// ---------- git ----------

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function letterOf(x: string): GitCode | null {
  switch (x) {
    case 'M': case 'T': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case 'C': return 'C';
    default: return null;
  }
}

/**
 * Parser de `git status --porcelain=v1 -z [-uall] [--ignored=matching]`.
 * Cada registro é `XY caminho\0`; renomeação/cópia (R/C) traz o caminho antigo no registro seguinte
 * (`XY novo\0antigo\0`). Também aceita a forma sem -z (`R  antigo -> novo`) por tolerância.
 * Regras de letra e prioridade iguais às da extensão git do VS Code (repository.ts):
 * `??` → U, conflitos → `!`, working tree vence o índice quando os dois têm estado;
 * `staged` = true só quando não sobra mudança fora do índice.
 * Entradas `!!` (ignoradas) saem em `ignored`, não no mapa.
 */
export function parsePorcelain(out: string): { files: GitStatusMap; ignored: string[] } {
  const files: GitStatusMap = {};
  const ignored: string[] = [];
  if (!out) return { files, ignored };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    // Sem -z as linhas vêm separadas por \n
    const lines = rec.includes('\n') ? rec.split('\n').filter(Boolean) : [rec];
    for (const line of lines) {
      if (line.length < 4) continue;
      const xy = line.slice(0, 2);
      let p = line.slice(3);
      const x = xy[0];
      const y = xy[1];
      const isRename = x === 'R' || x === 'C' || y === 'R' || y === 'C';
      if (isRename) {
        if (p.includes(' -> ')) {
          p = p.slice(p.indexOf(' -> ') + 4);
        } else if (lines.length === 1) {
          i++; // o próximo token é o caminho antigo; o novo é o que decoramos
        }
      }
      p = p.replace(/\/$/, '');
      if (xy === '!!') { ignored.push(p); continue; }
      if (xy === '??') { files[p] = { code: 'U', staged: false }; continue; }
      if (CONFLICTS.has(xy)) { files[p] = { code: '!', staged: false }; continue; }
      const work = y !== ' ' ? letterOf(y) : null;
      const index = x !== ' ' ? letterOf(x) : null;
      if (work) files[p] = { code: work, staged: false };
      else if (index) files[p] = { code: index, staged: true };
    }
  }
  return { files, ignored };
}

// Prioridade ao escolher a cor de uma pasta com filhos em estados diferentes: conflito > modificado > demais
// (mesma escala de Resource.priority da extensão git; VS Code usa a primeira encontrada quando o peso empata).
const PRIORITY: Record<GitCode, number> = { '!': 4, M: 2, A: 1, U: 1, R: 1, C: 1, D: 0, '?': 0 };

/**
 * Propaga o estado dos arquivos para as pastas ancestrais (o "bubble" do decorationsService):
 * toda pasta que contém um descendente alterado recebe { code } com o estado de maior prioridade.
 * Exclusões (D) não propagam, como `propagate = type !== DELETED` no VS Code. `''` é a raiz.
 */
export function folderBadges(files: GitStatusMap): Record<string, { code: GitCode }> {
  const out: Record<string, { code: GitCode }> = {};
  for (const [p, st] of Object.entries(files)) {
    if (st.code === 'D') continue;
    const parts = p.split('/');
    parts.pop();
    const dirs = [''];
    for (let i = 0; i < parts.length; i++) dirs.push(parts.slice(0, i + 1).join('/'));
    for (const d of dirs) {
      const cur = out[d];
      if (!cur || PRIORITY[st.code] > PRIORITY[cur.code]) out[d] = { code: st.code };
    }
  }
  return out;
}

/** Linhas de `git log --format=%H%x1f%an%x1f%at%x1f%s`. */
export type Commit = { hash: string; author: string; date: number; subject: string };
export function parseLog(out: string): Commit[] {
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, author, at, ...rest] = line.split('\x1f');
    return { hash, author: author ?? '', date: Number(at) || 0, subject: rest.join('\x1f') ?? '' };
  }).filter(c => /^[0-9a-f]{7,40}$/.test(c.hash));
}

// ---------- binário / mime ----------

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'heic', 'avif',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'pyc', 'wasm', 'bin', 'dat',
  'sqlite', 'sqlite3', 'db', 'node', 'psd', 'ai', 'sketch', 'fig',
]);

export function extOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** Binário por extensão ou por byte nulo nos primeiros 8 KB (o mesmo critério do git/VS Code). */
export function isBinary(name: string, head?: Uint8Array | null): boolean {
  if (BINARY_EXT.has(extOf(name))) return true;
  if (!head) return false;
  const n = Math.min(head.length, 8000);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', csv: 'text/csv', xml: 'text/xml',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

export function mimeOf(name: string): string {
  return MIME[extOf(name)] ?? 'application/octet-stream';
}

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
export function isImage(name: string): boolean {
  return IMAGE_EXT.has(extOf(name));
}
