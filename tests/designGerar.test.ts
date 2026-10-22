import { describe, it, expect } from 'vitest';
import { gerarOuAjustarDesign, montarPromptAjuste, montarPromptInicial, type DesignQuery, type HistoricoItem } from '../server/design/gerar.js';

function fakePool(estado: { html: string | null; status: string; historico: HistoricoItem[] }) {
  const updates: any[] = [];
  const query: DesignQuery = async (sql, params) => {
    if (sql.startsWith('SELECT')) return { rows: [estado], rowCount: 1 };
    updates.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  return { query, updates };
}

describe('montarPromptInicial', () => {
  it('inclui o tema literal', () => {
    expect(montarPromptInicial('cartão de visita minimalista')).toContain('cartão de visita minimalista');
  });
});

describe('montarPromptAjuste', () => {
  it('inclui o html atual, o histórico e a instrução nova', () => {
    const p = montarPromptAjuste('<html>X</html>', [{ role: 'pedido', texto: 'tema A', ts: '2026-01-01' }], 'deixa o fundo escuro');
    expect(p).toContain('<html>X</html>');
    expect(p).toContain('tema A');
    expect(p).toContain('deixa o fundo escuro');
  });
});

describe('gerarOuAjustarDesign', () => {
  it('pedido inicial: grava html, status pronto e acrescenta ao histórico', async () => {
    const { query, updates } = fakePool({ html: null, status: 'gerando', historico: [] });
    await gerarOuAjustarDesign(query, 1, null, null, async () => '<html>novo</html>');
    const upd = updates.find(u => u.sql.includes("status = 'pronto'"));
    expect(upd.params).toContain('<html>novo</html>');
  });

  it('ajuste: usa o html atual no prompt do gerador', async () => {
    const { query } = fakePool({ html: '<html>velho</html>', status: 'pronto', historico: [{ role: 'pedido', texto: 'tema', ts: '2026-01-01' }] });
    let promptRecebido = '';
    await gerarOuAjustarDesign(query, 1, 'deixa mais escuro', null, async (p) => { promptRecebido = p; return '<html>ajustado</html>'; });
    expect(promptRecebido).toContain('<html>velho</html>');
    expect(promptRecebido).toContain('deixa mais escuro');
  });

  it('erro do gerador: grava status erro e mensagem, nunca lança', async () => {
    const { query, updates } = fakePool({ html: null, status: 'gerando', historico: [] });
    await expect(gerarOuAjustarDesign(query, 1, null, null, async () => { throw new Error('timeout'); })).resolves.toBeUndefined();
    const upd = updates.find(u => u.sql.includes("status = 'erro'"));
    expect(upd.params.join(' ')).toContain('timeout');
  });
});
