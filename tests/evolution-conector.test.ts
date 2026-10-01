import { describe, expect, it } from 'vitest';
import { bloqueadoNaEvolution, evolutionParaHeader } from '../server/tools/evolution.js';
import { buildSystemAppend } from '../server/claude/header.js';

describe('Evolution (conector simples)', () => {
  it('bloqueia só apagar e deslogar instância', () => {
    expect(bloqueadoNaEvolution('DELETE', 'instance/delete/TM-01')).toBe(true);
    expect(bloqueadoNaEvolution('DELETE', '/instance/logout/TM-01')).toBe(true);
    expect(bloqueadoNaEvolution('GET', 'instance/fetchInstances')).toBe(false);
    expect(bloqueadoNaEvolution('POST', 'instance/create')).toBe(false);
    expect(bloqueadoNaEvolution('POST', 'message/sendText/X')).toBe(false);
  });
  it('entra no cabeçalho só quando configurada, sem a chave', () => {
    expect(evolutionParaHeader(null)).toBeNull();
    const h = evolutionParaHeader({ url: 'https://evo.bayerl.cloud' })!;
    expect(h.url).toMatch(/\/conector\/evolution$/);
    const txt = buildSystemAppend({ projectName: 'Orion', projectPath: '/srv/orion', createdBy: 'Danilo', evolution: h });
    expect(txt).toContain('/conector/evolution/instance/fetchInstances');
    expect(buildSystemAppend({ projectName: 'Orion', projectPath: '/srv/orion', createdBy: 'Danilo' })).not.toContain('Evolution');
  });
});
