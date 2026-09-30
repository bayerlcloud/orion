import { describe, it, expect } from 'vitest';
import { slugPessoa, hostPreview, instancia, proximaPorta, paresFaltando, temPreview, nomeDoPreview } from '../server/preview/model';

describe('preview model', () => {
  it('slugPessoa', () => {
    expect(slugPessoa('Laís')).toBe('lais');
    expect(slugPessoa('Laís Souza')).toBe('lais-souza');
    expect(slugPessoa('  Gustavo!! ')).toBe('gustavo');
  });
  it('hosts', () => {
    expect(hostPreview('danilo', 'fisioexpert')).toBe('danilo.fisioexpert.bayerl.cloud');
    expect(hostPreview(null, 'fisioexpert')).toBe('fisioexpert.bayerl.cloud');
    expect(instancia('lais.ralab.bayerl.cloud')).toBe('lais.ralab');
    expect(instancia('fisioexpert.bayerl.cloud')).toBe('fisioexpert');
  });
  it('proximaPorta pega a menor livre na faixa 9100 a 9999', () => {
    expect(proximaPorta([])).toBe(9100);
    expect(proximaPorta([9100, 9101, 9103])).toBe(9102);
    expect(() => proximaPorta(Array.from({ length: 900 }, (_, i) => 9100 + i))).toThrow();
  });
  it('paresFaltando: uma raiz por projeto e um por pessoa e projeto, sem repetir o que existe', () => {
    const faltam = paresFaltando([1, 2], [10, 20], [{ project_id: 1, user_id: null }, { project_id: 1, user_id: 10 }]);
    expect(faltam).toEqual([
      { project_id: 1, user_id: 20 },
      { project_id: 2, user_id: null }, { project_id: 2, user_id: 10 }, { project_id: 2, user_id: 20 },
    ]);
    expect(paresFaltando([1], [10], [{ project_id: 1, user_id: null }, { project_id: 1, user_id: 10 }])).toEqual([]);
  });
});

describe('temPreview', () => {
  it('só projeto com package.json na pasta ganha preview', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const path = await import('node:path');
    const d = await mkdtemp(path.join(tmpdir(), 'tp-'));
    expect(await temPreview(d, null)).toBe(false);
    await writeFile(path.join(d, 'package.json'), '{}');
    expect(await temPreview(d, null)).toBe(true);
    expect(await temPreview(d, 'apps/x')).toBe(false);
  });
});

describe('nomeDoPreview', () => {
  it('usa preview_host do meta quando existe, senão o slug', () => {
    expect(nomeDoPreview('orion', 'orionpreview')).toBe('orionpreview');
    expect(nomeDoPreview('fisioexpert', null)).toBe('fisioexpert');
    expect(hostPreview('danilo', nomeDoPreview('orion', 'orionpreview'))).toBe('danilo.orionpreview.bayerl.cloud');
  });
  it('preview_host inválido cai no slug', () => {
    expect(nomeDoPreview('orion', 'Orion Preview!')).toBe('orion');
    expect(nomeDoPreview('orion', 'a.b')).toBe('orion');
  });
});
