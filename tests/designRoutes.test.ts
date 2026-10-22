import { describe, it, expect } from 'vitest';
import { marcarGerandoSeLivre, podeApagar } from '../server/routes/design.js';
import type { DesignQuery } from '../server/design/gerar.js';

describe('podeApagar', () => {
  it('autor pode apagar o próprio design', () => {
    expect(podeApagar({ id: 5, role: 'member' }, { user_id: 5 })).toBe(true);
  });
  it('owner pode apagar design de qualquer um', () => {
    expect(podeApagar({ id: 1, role: 'owner' }, { user_id: 5 })).toBe(true);
  });
  it('member não pode apagar design de outra pessoa', () => {
    expect(podeApagar({ id: 2, role: 'member' }, { user_id: 5 })).toBe(false);
  });
});

describe('marcarGerandoSeLivre', () => {
  it('livre: marca gerando com um UPDATE só (atômico) e devolve ok', async () => {
    const chamadas: string[] = [];
    const query: DesignQuery = async (sql) => { chamadas.push(sql); return { rows: [{ id: 1 }], rowCount: 1 }; };
    expect(await marcarGerandoSeLivre(query, 1)).toBe('ok');
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toContain("status <> 'gerando'");
  });

  it('já gerando: UPDATE não afeta linha, SELECT confirma que existe → ocupado', async () => {
    const query: DesignQuery = async (sql) => sql.startsWith('UPDATE') ? { rows: [], rowCount: 0 } : { rows: [{ x: 1 }], rowCount: 1 };
    expect(await marcarGerandoSeLivre(query, 1)).toBe('ocupado');
  });

  it('inexistente: UPDATE não afeta linha, SELECT não acha nada → inexistente', async () => {
    const query: DesignQuery = async () => ({ rows: [], rowCount: 0 });
    expect(await marcarGerandoSeLivre(query, 1)).toBe('inexistente');
  });
});
