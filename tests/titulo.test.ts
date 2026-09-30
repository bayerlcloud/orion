import { describe, expect, it } from 'vitest';
import { limparTitulo } from '../server/claude/titulo.js';

describe('limparTitulo', () => {
  it('tira aspas, ponto, prefixo e capitaliza', () => {
    expect(limparTitulo('"ajuste home."')).toBe('Ajuste home');
    expect(limparTitulo('Título: Gestão de usuários\nexplicação')).toBe('Gestão de usuários');
    expect(limparTitulo('Migração — banco')).toBe('Migração banco');
  });
  it('descarta vazio ou longo demais', () => {
    expect(limparTitulo('  ')).toBe('');
    expect(limparTitulo('Isto aqui é uma frase inteira longa demais para ser um título')).toBe('');
  });
});
