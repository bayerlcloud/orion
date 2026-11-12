/**
 * Redução de imagem ANTES do upload (medido em 12/11/2026: a subida do celular do Danilo é 27 KB/s na
 * mediana; um print de 1,5 MB levava 60 s, e imagem acima de 3,7 MB estoura o limite de 5 MB em base64
 * da API). Reencoda em JPEG com lado máximo de 2048 px só quando vale: acima de 400 KB ou maior que
 * 2048 px. GIF e SVG ficam como estão. Qualquer falha devolve o arquivo original (nunca perde o anexo).
 * Funções puras no topo (tests/imagem.test.ts); canvas embaixo.
 */
export const IMAGEM_LADO_MAX = 2048;
export const IMAGEM_BYTES_MIN = 400 * 1024;

export function dimensoesReduzidas(w: number, h: number, max = IMAGEM_LADO_MAX): { w: number; h: number } {
  const f = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)) };
}

export function valeReduzir(type: string, size: number, w?: number, h?: number, max = IMAGEM_LADO_MAX): boolean {
  if (!/^image\/(png|jpe?g|webp|bmp|tiff?)$/i.test(type)) return false;
  return size > IMAGEM_BYTES_MIN || (w !== undefined && h !== undefined && Math.max(w, h) > max);
}

export async function reduzirImagem(file: File, max = IMAGEM_LADO_MAX, qualidade = 0.85): Promise<File> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
    if (!valeReduzir(file.type, file.size)) return file;
    const bmp = await createImageBitmap(file);
    if (!valeReduzir(file.type, file.size, bmp.width, bmp.height, max)) { bmp.close(); return file; }
    const { w, h } = dimensoesReduzidas(bmp.width, bmp.height, max);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close(); return file; }
    ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', qualidade));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch { return file; }
}
