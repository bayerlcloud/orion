import { describe, it, expect } from 'vitest';
import { paraFala, pedacos } from '../web/src/claude/fala';

describe('ouvir resposta', () => {
  it('limpa markdown e não lê bloco de código', () => {
    const t = paraFala('## Título\n**Negrito** e `cmd` com [link](http://x).\n```ts\nconst a = 1;\n```\n- item');
    expect(t).not.toMatch(/[#*`]|const a|http/);
    expect(t).toContain('Negrito e cmd com link');
    expect(t).toContain('(bloco de código)');
    expect(t).toContain('item');
  });
  it('quebra em pedaços curtos por frase', () => {
    const p = pedacos('Primeira frase. Segunda frase!\nTerceira');
    expect(p).toEqual(['Primeira frase.', 'Segunda frase!', 'Terceira']);
    expect(pedacos('a'.repeat(50) + ', b.').length).toBe(1);
  });
});
