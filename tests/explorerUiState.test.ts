import { describe, it, expect } from 'vitest';
import { filterStaleExpandedKeys, keyOf, splitKey } from '../web/src/files/types';

describe('keyOf / splitKey — chave de pasta expandida (${rootId}|${rel})', () => {
  it('são inversas, inclusive com barras e rel vazio (raiz)', () => {
    expect(splitKey(keyOf(42, 'a/b/c'))).toEqual({ rootId: 42, rel: 'a/b/c' });
    expect(splitKey(keyOf(7, ''))).toEqual({ rootId: 7, rel: '' });
  });
});

describe('filterStaleExpandedKeys — restaurando /api/files/ui-state', () => {
  it('mantém chaves de raízes que ainda existem', () => {
    const keys = [keyOf(1, ''), keyOf(1, 'src'), keyOf(1, 'src/pages')];
    expect(filterStaleExpandedKeys(keys, new Set([1]))).toEqual(keys);
  });

  it('descarta chaves de um projeto removido, sem travar', () => {
    const keys = [keyOf(1, ''), keyOf(2, 'lib'), keyOf(3, 'a/b')];
    expect(filterStaleExpandedKeys(keys, new Set([1, 3]))).toEqual([keyOf(1, ''), keyOf(3, 'a/b')]);
  });

  it('aceita validRootIds como array, não só Set', () => {
    expect(filterStaleExpandedKeys([keyOf(5, 'x')], [5])).toEqual([keyOf(5, 'x')]);
    expect(filterStaleExpandedKeys([keyOf(5, 'x')], [9])).toEqual([]);
  });

  it('ignora entradas sujas vindas do banco (não string, sem separador, número solto)', () => {
    const sujo = [123, 'sem-separador', null, keyOf(1, 'ok')] as unknown[];
    expect(filterStaleExpandedKeys(sujo, new Set([1]))).toEqual([keyOf(1, 'ok')]);
  });

  it('lista vazia continua vazia (preferência explicitamente "tudo colapsado")', () => {
    expect(filterStaleExpandedKeys([], new Set([1, 2]))).toEqual([]);
  });
});
