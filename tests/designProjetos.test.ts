import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  extrairZip, mediaTypeDeImagem, mimeDeArquivo, montarBlocosReferencia, tipoDeArquivo,
  tipoSeguroParaView, type DesignQuery,
} from '../server/design/projetos.js';

describe('tipoDeArquivo', () => {
  it('classifica imagem, texto e ignorado', () => {
    expect(tipoDeArquivo('logo.png')).toBe('imagem');
    expect(tipoDeArquivo('estilo.css')).toBe('texto');
    expect(tipoDeArquivo('icone.svg')).toBe('texto'); // svg é XML, não vira bloco de imagem
    expect(tipoDeArquivo('documento.pdf')).toBe('ignorado');
    expect(tipoDeArquivo('sem_extensao')).toBe('ignorado');
  });
});

describe('mediaTypeDeImagem', () => {
  it('mapeia extensão pro media_type aceito pela API', () => {
    expect(mediaTypeDeImagem('a.jpg')).toBe('image/jpeg');
    expect(mediaTypeDeImagem('a.png')).toBe('image/png');
    expect(mediaTypeDeImagem('a.svg')).toBeNull();
  });
});

describe('mimeDeArquivo', () => {
  it('imagem conhecida: devolve o media_type certo, pra miniatura funcionar mesmo vindo de dentro de um zip', () => {
    expect(mimeDeArquivo('assets/logo.png')).toBe('image/png');
    expect(mimeDeArquivo('foto.jpg')).toBe('image/jpeg');
  });
  it('não-imagem: cai pro genérico', () => {
    expect(mimeDeArquivo('estilo.css')).toBe('application/octet-stream');
  });
});

describe('extrairZip', () => {
  it('lista os arquivos de dentro, ignora pastas', () => {
    const zip = new AdmZip();
    zip.addFile('assets/logo.png', Buffer.from('fake-png'));
    zip.addFile('estilo.css', Buffer.from('body{}'));
    zip.addFile('assets/', Buffer.alloc(0)); // entrada de pasta
    const entradas = extrairZip(zip.toBuffer());
    expect(entradas.map(e => e.nome).sort()).toEqual(['assets/logo.png', 'estilo.css']);
  });

  it('ignora lixo do zip do Mac (__MACOSX e ._arquivo) — senão vira "imagem" inválida e quebra a geração', () => {
    const zip = new AdmZip();
    zip.addFile('assets/logo.png', Buffer.from('fake-png'));
    zip.addFile('__MACOSX/assets/._logo.png', Buffer.from('lixo-do-finder'));
    zip.addFile('._estilo.css', Buffer.from('lixo-do-finder'));
    const entradas = extrairZip(zip.toBuffer());
    expect(entradas.map(e => e.nome)).toEqual(['assets/logo.png']);
  });
});

describe('montarBlocosReferencia', () => {
  it('monta bloco de imagem (base64) e bloco de texto, pula ignorado', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'design-projetos-'));
    process.env.DESIGN_PROJECTS_DIR = dir;
    await writeFile(path.join(dir, 'img.png'), Buffer.from('fake-png-bytes'));
    await writeFile(path.join(dir, 'texto.txt'), 'conteúdo de referência');
    const query: DesignQuery = async () => ({
      rows: [
        { nome: 'logo.png', caminho_disco: 'img.png' },
        { nome: 'notas.txt', caminho_disco: 'texto.txt' },
        { nome: 'planilha.xlsx', caminho_disco: 'nao-existe' },
      ], rowCount: 3,
    });
    const blocos = await montarBlocosReferencia(query, 1);
    expect(blocos).toHaveLength(2);
    expect(blocos.find(b => b.type === 'image')).toMatchObject({ type: 'image', media_type: 'image/png' });
    expect(blocos.find(b => b.type === 'text')).toMatchObject({ type: 'text' });
    expect((blocos.find(b => b.type === 'text') as any).text).toContain('conteúdo de referência');
  });

  it('nunca lança se um arquivo não existir em disco', async () => {
    const query: DesignQuery = async () => ({ rows: [{ nome: 'sumiu.png', caminho_disco: 'nao-existe-mesmo' }], rowCount: 1 });
    await expect(montarBlocosReferencia(query, 1)).resolves.toEqual([]);
  });
});

describe('tipoSeguroParaView', () => {
  it('imagem de verdade: inline, sem forçar download', () => {
    expect(tipoSeguroParaView('image/png')).toEqual({ type: 'image/png', attachment: false });
    expect(tipoSeguroParaView('image/jpeg')).toEqual({ type: 'image/jpeg', attachment: false });
  });

  it('html/svg/qualquer outro mime: nunca inline (evita XSS armazenado servido na origem do Orion)', () => {
    expect(tipoSeguroParaView('text/html')).toEqual({ type: 'application/octet-stream', attachment: true });
    expect(tipoSeguroParaView('image/svg+xml')).toEqual({ type: 'application/octet-stream', attachment: true });
    expect(tipoSeguroParaView('application/octet-stream')).toEqual({ type: 'application/octet-stream', attachment: true });
  });
});
