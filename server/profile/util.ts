/** Helpers puros do perfil — testados em tests/profile.test.ts. Sem I/O, sem estado. */

/** Extensões de avatar aceitas no disco. */
export const AVATAR_EXTS = ['png', 'jpg', 'webp', 'gif'] as const;
export type AvatarExt = (typeof AVATAR_EXTS)[number];

/** Deixa só +()-, espaço e dígitos; recorta espaços das pontas; no máximo 30 caracteres. */
export function sanitizePhone(s: unknown): string {
  const kept = String(s ?? '').replace(/[^+()\-\s0-9]/g, '');
  return kept.trim().slice(0, 30).trim();
}

/** MIME de imagem aceito → extensão gravada. image/jpeg vira "jpg". Fora da lista → null. */
export function extForMime(mime: unknown): AvatarExt | null {
  switch (String(mime ?? '').toLowerCase().trim().split(';')[0].trim()) {
    case 'image/png': return 'png';
    case 'image/jpeg':
    case 'image/jpg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return null;
  }
}

/** Extensão gravada → Content-Type para servir o arquivo. */
export function mimeForExt(ext: unknown): string {
  switch (String(ext ?? '').toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

/** Nome obrigatório: apara, não pode ficar vazio e no máximo 80. Lança em caso inválido. */
export function validName(s: unknown): string {
  const t = String(s ?? '').trim();
  if (!t) throw new Error('nome obrigatório');
  if (t.length > 80) throw new Error('nome muito longo (máx. 80)');
  return t;
}

/** Sobrenome opcional: apara; vazio vira null; no máximo 80. Lança se passar de 80. */
export function validSurname(s: unknown): string | null {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (t.length > 80) throw new Error('sobrenome muito longo (máx. 80)');
  return t;
}

/** Tema: só 'dark' ou 'light'. Lança em qualquer outro valor. */
export function validTheme(s: unknown): 'dark' | 'light' {
  if (s === 'dark' || s === 'light') return s;
  throw new Error('tema inválido');
}
