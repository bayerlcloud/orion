const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Tamanho legível em pt-BR: "512 B", "1,5 KB", "2,3 MB", "1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const dec = i === 0 || v >= 100 ? 0 : 1;
  const txt = v.toFixed(dec).replace(/\.0$/, '').replace('.', ',');
  return `${txt} ${UNITS[i]}`;
}

const GENERIC_STEM = /^(image|img|imagem|blob|paste|pasted|screenshot|clipboard|untitled|sem[_ -]?titulo)$/i;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Nome para um arquivo colado (Ctrl/Cmd+V). Arquivos com nome real (contrato.pdf)
 * mantêm o nome; prints e nomes genéricos (image.png, blob) viram
 * "captura-AAAA-MM-DD-HHMM.ext", com a extensão vinda do mime.
 */
export function pasteFilename(original: string, mime: string, when: Date = new Date()): string {
  const name = (original ?? '').trim();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const origExt = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const generic = !stem || GENERIC_STEM.test(stem);
  if (!generic) return name;
  const ext = EXT_BY_MIME[(mime ?? '').toLowerCase()] || origExt || 'bin';
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `captura-${stamp}.${ext}`;
}
