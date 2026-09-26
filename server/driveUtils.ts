import path from 'node:path';

const MAX_NAME = 120;

/**
 * Nome seguro para gravar em disco: só o basename (sem diretório), sem acentos,
 * sem espaços, só [A-Za-z0-9._-]. Nunca começa com "." ou "-" (evita oculto, ".." e
 * argumento de shell). O nome original fica no banco para exibição.
 */
export function safeFilename(original: string): string {
  const base = (original ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  let s = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^A-Za-z0-9._-]+/g, '_');
  s = s.replace(/_+/g, '_').replace(/_+(?=\.)/g, '').replace(/^[.-]+/, '').replace(/[._-]+$/, '');
  if (!s) s = 'arquivo';
  if (s.length > MAX_NAME) {
    const ext = path.extname(s);
    const stem = s.slice(0, s.length - ext.length);
    s = stem.slice(0, Math.max(1, MAX_NAME - ext.length)) + ext;
  }
  return s;
}

/** Nome de exibição ao renomear: mantém acentos e espaços, tira caminho e controla o tamanho. */
export function displayName(input: string): string {
  const base = (input ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const s = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_NAME) || 'arquivo';
}
