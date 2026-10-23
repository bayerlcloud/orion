import path from 'node:path';
import { readFile } from 'node:fs/promises';
import AdmZip from 'adm-zip';

export type { DesignQuery } from './gerar.js';
import type { DesignQuery } from './gerar.js';

export function projectsDir(): string {
  return path.resolve(process.env.DESIGN_PROJECTS_DIR ?? '/srv/design-projects');
}

export type TipoArquivo = 'imagem' | 'texto' | 'ignorado';

const EXT_IMAGEM = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const EXT_TEXTO = new Set(['.css', '.html', '.json', '.md', '.txt', '.yml', '.yaml', '.svg']);

export function tipoDeArquivo(nome: string): TipoArquivo {
  const ext = path.extname(nome).toLowerCase();
  if (EXT_IMAGEM.has(ext)) return 'imagem';
  if (EXT_TEXTO.has(ext)) return 'texto';
  return 'ignorado';
}

export type MediaTypeImagem = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const MEDIA_TYPE: Record<string, MediaTypeImagem> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export function mediaTypeDeImagem(nome: string): MediaTypeImagem | null {
  return MEDIA_TYPE[path.extname(nome).toLowerCase()] ?? null;
}

/** Melhor palpite de mime por extensão, pra arquivos extraídos de zip (AdmZip não dá mimetype). */
export function mimeDeArquivo(nome: string): string {
  return mediaTypeDeImagem(nome) ?? 'application/octet-stream';
}

const MIME_INLINE_SEGURO = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Decide se o `/view` pode servir o mime inline. Upload avulso guarda o mime que o NAVEGADOR DO
 * CLIENTE declarou (part.mimetype) — alguém pode subir um .html/.svg com script e mandar o link
 * pra outra pessoa do time abrir; servir isso inline na origem do Orion seria XSS armazenado com
 * a sessão de quem clicar. Só as imagens que a API de visão aceita saem inline; o resto força
 * download (`attachment`), nunca executa no navegador.
 */
export function tipoSeguroParaView(mime: string): { type: string; attachment: boolean } {
  return MIME_INLINE_SEGURO.has(mime) ? { type: mime, attachment: false } : { type: 'application/octet-stream', attachment: true };
}

export type EntradaZip = { nome: string; dados: Buffer };

/** Lixo que o Finder do Mac põe em todo zip: não é conteúdo real, e um "._arquivo.png" vira imagem inválida. */
function ehLixoDeZipMac(nome: string): boolean {
  return nome.startsWith('__MACOSX/') || path.basename(nome).startsWith('._');
}

export function extrairZip(buffer: Buffer): EntradaZip[] {
  const zip = new AdmZip(buffer);
  return zip.getEntries()
    .filter(e => !e.isDirectory && !ehLixoDeZipMac(e.entryName))
    .map(e => ({ nome: e.entryName, dados: e.getData() }));
}

export type ConteudoBloco =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: MediaTypeImagem; data: string };

/** Monta os blocos multimodais (imagem + texto) dos arquivos de um projeto. Nunca lança: arquivo que falhar ao ler é pulado. */
export async function montarBlocosReferencia(query: DesignQuery, projectId: number): Promise<ConteudoBloco[]> {
  const { rows } = await query(
    'SELECT nome, caminho_disco FROM design_project_files WHERE project_id = $1 ORDER BY created_at', [projectId]);
  const blocos: ConteudoBloco[] = [];
  for (const row of rows) {
    const tipo = tipoDeArquivo(row.nome);
    if (tipo === 'ignorado') continue;
    try {
      const caminho = path.join(projectsDir(), row.caminho_disco);
      if (tipo === 'imagem') {
        const bytes = await readFile(caminho);
        blocos.push({ type: 'image', media_type: mediaTypeDeImagem(row.nome)!, data: bytes.toString('base64') });
      } else {
        const conteudo = await readFile(caminho, 'utf8');
        blocos.push({ type: 'text', text: `== ${row.nome} ==\n${conteudo}` });
      }
    } catch { /* arquivo sumiu ou corrompido: não pode quebrar a geração */ }
  }
  return blocos;
}
