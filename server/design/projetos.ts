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

export type EntradaZip = { nome: string; dados: Buffer };

export function extrairZip(buffer: Buffer): EntradaZip[] {
  const zip = new AdmZip(buffer);
  return zip.getEntries()
    .filter(e => !e.isDirectory)
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
