import { describe, it, expect } from 'vitest';
import { chaveRascunho, chaveConteudo, rascunhoMaisNovo, lerRascunhoLocal, gravarRascunhoLocal, rascunhoVazio, RASCUNHO_TEXTO_MAX, type ArmazemRascunho } from '../web/src/claude/rascunho';
import type { Attachment } from '../web/src/claude/api';

const img: Attachment = { kind: 'image', media_type: 'image/png', name: 'a.png', path: '/srv/uploads/1/a.png' };

function armazem(): ArmazemRascunho & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } };
}

describe('chaveRascunho / chaveConteudo', () => {
  it('uma chave por sessão, com prefixo do Orion', () => {
    expect(chaveRascunho('abc')).toBe('orion.rascunho.abc');
    expect(chaveRascunho('abc')).not.toBe(chaveRascunho('abd'));
  });
  it('conteúdo igual = mesma chave; anexo diferente ou texto diferente mudam', () => {
    expect(chaveConteudo({ text: 'oi', attachments: [img] })).toBe(chaveConteudo({ text: 'oi', attachments: [{ ...img, name: 'outro.png' }] }));
    expect(chaveConteudo({ text: 'oi', attachments: [] })).not.toBe(chaveConteudo({ text: 'oi', attachments: [img] }));
    expect(chaveConteudo(undefined)).toBe(chaveConteudo({ text: '', attachments: [] }));
  });
  it('rascunhoVazio: sem texto e sem anexo', () => {
    expect(rascunhoVazio(undefined)).toBe(true);
    expect(rascunhoVazio({ text: '', attachments: [] })).toBe(true);
    expect(rascunhoVazio({ text: '', attachments: [img] })).toBe(false);
  });
});

describe('rascunhoMaisNovo', () => {
  it('sem nada, nada', () => { expect(rascunhoMaisNovo(undefined, undefined)).toBeUndefined(); });
  it('só servidor: usa o servidor, marcado como salvo', () => {
    expect(rascunhoMaisNovo(undefined, { text: 'do servidor', attachments: [] })).toEqual({ text: 'do servidor', attachments: [], salvo: true });
  });
  it('local que não subiu vence o servidor (401 ou fechou a página antes do autosave)', () => {
    expect(rascunhoMaisNovo({ text: 'digitei e caiu', attachments: [], salvo: false }, { text: 'velho', attachments: [] })!.text).toBe('digitei e caiu');
  });
  it('local já sincronizado cede ao servidor (outro aparelho pode ter editado depois)', () => {
    expect(rascunhoMaisNovo({ text: 'igual', attachments: [], salvo: true }, { text: 'mais novo', attachments: [] })!.text).toBe('mais novo');
  });
  it('local sincronizado e servidor vazio: foi enviado em outro lugar, não volta', () => {
    expect(rascunhoMaisNovo({ text: 'enviado', attachments: [], salvo: true }, undefined)).toBeUndefined();
  });
  it('local vazio não conta como mais novo', () => {
    expect(rascunhoMaisNovo({ text: '', attachments: [], salvo: false }, { text: 'servidor', attachments: [] })!.text).toBe('servidor');
  });
  it('só anexo também é rascunho', () => {
    expect(rascunhoMaisNovo({ text: '', attachments: [img], salvo: false }, undefined)!.attachments).toEqual([img]);
  });
});

describe('lerRascunhoLocal / gravarRascunhoLocal', () => {
  it('ida e volta', () => {
    const a = armazem();
    gravarRascunhoLocal(a, 's1', { text: 'oi', attachments: [img], salvo: false });
    expect(lerRascunhoLocal(a, 's1')).toEqual({ text: 'oi', attachments: [img], salvo: false });
    expect(lerRascunhoLocal(a, 's2')).toBeUndefined();
  });
  it('vazio apaga a chave', () => {
    const a = armazem();
    gravarRascunhoLocal(a, 's1', { text: 'oi', attachments: [], salvo: false });
    gravarRascunhoLocal(a, 's1', { text: '', attachments: [], salvo: true });
    expect(a.m.has(chaveRascunho('s1'))).toBe(false);
  });
  it('corta o texto no limite do servidor', () => {
    const a = armazem();
    gravarRascunhoLocal(a, 's1', { text: 'x'.repeat(RASCUNHO_TEXTO_MAX + 10), attachments: [], salvo: false });
    expect(lerRascunhoLocal(a, 's1')!.text.length).toBe(RASCUNHO_TEXTO_MAX);
  });
  it('JSON inválido, formato estranho ou anexo sem caminho não quebram', () => {
    const a = armazem();
    a.m.set(chaveRascunho('s1'), '{nao e json');
    expect(lerRascunhoLocal(a, 's1')).toBeUndefined();
    a.m.set(chaveRascunho('s2'), JSON.stringify({ text: 5 }));
    expect(lerRascunhoLocal(a, 's2')).toBeUndefined();
    a.m.set(chaveRascunho('s3'), JSON.stringify({ text: 'ok', attachments: [{ kind: 'file' }, img], salvo: 'sim' }));
    expect(lerRascunhoLocal(a, 's3')).toEqual({ text: 'ok', attachments: [img], salvo: false });
  });
  it('storage ausente ou que lança (modo privado, cota cheia) não propaga', () => {
    expect(lerRascunhoLocal(undefined, 's1')).toBeUndefined();
    expect(() => gravarRascunhoLocal(undefined, 's1', { text: 'oi', attachments: [], salvo: false })).not.toThrow();
    const quebrado: ArmazemRascunho = { getItem: () => { throw new Error('sem storage'); }, setItem: () => { throw new Error('cheio'); }, removeItem: () => { throw new Error('x'); } };
    expect(lerRascunhoLocal(quebrado, 's1')).toBeUndefined();
    expect(() => gravarRascunhoLocal(quebrado, 's1', { text: 'oi', attachments: [], salvo: false })).not.toThrow();
    expect(() => gravarRascunhoLocal(quebrado, 's1', { text: '', attachments: [], salvo: true })).not.toThrow();
  });
});
