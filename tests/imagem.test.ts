import { describe, it, expect } from 'vitest';
import { dimensoesReduzidas, valeReduzir, IMAGEM_LADO_MAX } from '../web/src/claude/imagem';

describe('redução de imagem antes do upload', () => {
  it('mantém a proporção e nunca aumenta', () => {
    expect(dimensoesReduzidas(4096, 2048)).toEqual({ w: 2048, h: 1024 });
    expect(dimensoesReduzidas(1000, 3000)).toEqual({ w: 683, h: 2048 });
    expect(dimensoesReduzidas(800, 600)).toEqual({ w: 800, h: 600 });
    expect(dimensoesReduzidas(0, 0)).toEqual({ w: 1, h: 1 });
  });
  it('só vale pra png/jpeg/webp grandes ou largas; gif e svg ficam', () => {
    expect(valeReduzir('image/png', 1_500_000)).toBe(true);
    expect(valeReduzir('image/png', 100_000)).toBe(false);
    expect(valeReduzir('image/png', 100_000, 4000, 100)).toBe(true);
    expect(valeReduzir('image/gif', 5_000_000)).toBe(false);
    expect(valeReduzir('image/svg+xml', 5_000_000)).toBe(false);
    expect(valeReduzir('application/pdf', 5_000_000)).toBe(false);
    expect(IMAGEM_LADO_MAX).toBe(2048);
  });
});
