import { describe, it, expect } from 'vitest';
import { safeFilename } from '../server/driveUtils.js';
import { formatBytes, pasteFilename } from '../web/src/pages/driveUtils';

describe('safeFilename', () => {
  it('tira acentos, espaços e parênteses', () => {
    expect(safeFilename('Relatório final (v2).pdf')).toBe('Relatorio_final_v2.pdf');
  });
  it('mantém nomes já limpos', () => {
    expect(safeFilename('foto_2026-09.jpg')).toBe('foto_2026-09.jpg');
  });
  it('ignora diretório e travessia de caminho', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\x\\foto.jpg')).toBe('foto.jpg');
    expect(safeFilename('/tmp/../a.txt')).toBe('a.txt');
  });
  it('não deixa começar com ponto ou hífen', () => {
    expect(safeFilename('.env')).toBe('env');
    expect(safeFilename('-rf.txt')).toBe('rf.txt');
    expect(safeFilename('..')).toBe('arquivo');
  });
  it('cai em "arquivo" quando não sobra nada', () => {
    expect(safeFilename('')).toBe('arquivo');
    expect(safeFilename('???')).toBe('arquivo');
    expect(safeFilename('   ')).toBe('arquivo');
  });
  it('corta nomes longos preservando a extensão', () => {
    const s = safeFilename('a'.repeat(300) + '.tar.gz');
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith('.gz')).toBe(true);
  });
  it('não tem barra nem caractere fora de [A-Za-z0-9._-]', () => {
    expect(safeFilename('ção/ü\u0000"ok".txt')).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('formatBytes', () => {
  it('bytes sem decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });
  it('KB/MB/GB com vírgula e uma casa', () => {
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2,5 GB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
  });
  it('a partir de 100 não mostra decimal', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB');
  });
  it('valores inválidos viram travessão', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});

describe('pasteFilename', () => {
  const quando = new Date(2026, 8, 25, 23, 11);
  it('print de tela vira captura-AAAA-MM-DD-HHMM.png', () => {
    expect(pasteFilename('image.png', 'image/png', quando)).toBe('captura-2026-09-25-2311.png');
  });
  it('sem nome usa a extensão do mime', () => {
    expect(pasteFilename('', 'image/jpeg', quando)).toBe('captura-2026-09-25-2311.jpg');
  });
  it('nome genérico sem mime conhecido cai em .bin', () => {
    expect(pasteFilename('blob', '', quando)).toBe('captura-2026-09-25-2311.bin');
  });
  it('arquivo com nome real mantém o nome', () => {
    expect(pasteFilename('contrato.pdf', 'application/pdf', quando)).toBe('contrato.pdf');
    expect(pasteFilename('Makefile', '', quando)).toBe('Makefile');
  });
  it('preenche zeros em mês, dia, hora e minuto', () => {
    expect(pasteFilename('image.png', 'image/png', new Date(2026, 0, 5, 7, 3))).toBe('captura-2026-01-05-0703.png');
  });
  it('colar de novo uma captura não renomeia', () => {
    expect(pasteFilename('captura-2026-09-25-2311.png', 'image/png', new Date(2027, 0, 1))).toBe('captura-2026-09-25-2311.png');
  });
});
