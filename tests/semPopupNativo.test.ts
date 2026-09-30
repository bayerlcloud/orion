import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Regra do Danilo (01/10/2026): nenhum pop-up do navegador no Orion. Use confirmar/avisar/perguntar de web/src/dialogo.tsx.
function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('sem pop-up nativo', () => {
  it('web/src não chama confirm/alert/prompt do navegador', () => {
    const achados = arquivos(path.resolve(__dirname, '../web/src')).flatMap(f =>
      readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i, l }))
        .filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /(^|[^.\w])(window\.)?(confirm|alert|prompt)\(/.test(l))
        .map(({ f, i }) => `${path.relative(process.cwd(), f)}:${i + 1}`));
    expect(achados).toEqual([]);
  });
});
