import { describe, it, expect } from 'vitest';
import {
  gerarOuAjustarDesign, limparGerandoPreso, mensagemDeErro, montarPromptAjuste, montarPromptInicial,
  type DesignQuery, type HistoricoItem,
} from '../server/design/gerar.js';

describe('mensagemDeErro', () => {
  it('subtype success com is_error: usa o texto real do erro (m.result), não a palavra "success"', () => {
    expect(mensagemDeErro({ subtype: 'success', result: 'an image in the conversation could not be processed' }))
      .toBe('an image in the conversation could not be processed');
  });
  it('outros subtypes: usa o subtype (não tem m.result pra usar)', () => {
    expect(mensagemDeErro({ subtype: 'error_max_turns' })).toBe('error_max_turns');
  });
});

function fakePool(estado: { tema: string; html: string | null; status: string; historico: HistoricoItem[] }) {
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
  it('inclui o tema original, o html atual, o histórico e a instrução nova', () => {
    const p = montarPromptAjuste('cartão de visita minimalista', '<html>X</html>', [{ role: 'pedido', texto: 'tema A', ts: '2026-01-01' }], 'deixa o fundo escuro');
    expect(p).toContain('cartão de visita minimalista');
    expect(p).toContain('<html>X</html>');
    expect(p).toContain('tema A');
    expect(p).toContain('deixa o fundo escuro');
  });

  it('nunca pede pra NÃO gerar HTML (a instrução não pode virar negativa)', () => {
    const p = montarPromptAjuste('tema', '<html>X</html>', [], 'ajuste qualquer');
    expect(p).not.toContain('não gere');
  });

  it('inclui o tema mesmo sem html atual (ajuste depois de uma geração que falhou)', () => {
    const p = montarPromptAjuste('cartão de visita minimalista', '', [], 'tenta de novo');
    expect(p).toContain('cartão de visita minimalista');
  });
});

describe('gerarOuAjustarDesign', () => {
  it('pedido inicial: grava html, status pronto e acrescenta ao histórico', async () => {
    const { query, updates } = fakePool({ tema: 'tema', html: null, status: 'gerando', historico: [] });
    await gerarOuAjustarDesign(query, 1, null, null, async () => '<html>novo</html>');
    const upd = updates.find(u => u.sql.includes("status = 'pronto'"));
    expect(upd.params).toContain('<html>novo</html>');
  });

  it('ajuste: usa o html atual e o tema original no bloco de texto do prompt', async () => {
    const { query } = fakePool({ tema: 'cartão de visita minimalista', html: '<html>velho</html>', status: 'pronto', historico: [{ role: 'pedido', texto: 'tema', ts: '2026-01-01' }] });
    let blocosRecebidos: any[] = [];
    await gerarOuAjustarDesign(query, 1, 'deixa mais escuro', null, async (blocos) => { blocosRecebidos = blocos; return '<html>ajustado</html>'; });
    const texto = (blocosRecebidos.find(b => b.type === 'text') as any).text;
    expect(texto).toContain('<html>velho</html>');
    expect(texto).toContain('deixa mais escuro');
    expect(texto).toContain('cartão de visita minimalista');
  });

  it('com project_id: chama montarBlocosReferencia (busca os arquivos do projeto) e devolve o texto do pedido primeiro', async () => {
    const sqlsChamados: string[] = [];
    const query: DesignQuery = async (sql) => {
      sqlsChamados.push(sql);
      if (sql.includes('FROM designs')) return { rows: [{ tema: 'tema', html: null, historico: [], project_id: 7 }], rowCount: 1 };
      if (sql.includes('design_project_files')) return { rows: [{ nome: 'ref.txt', caminho_disco: 'x' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    let blocosRecebidos: any[] = [];
    await gerarOuAjustarDesign(query, 1, null, null, async (blocos) => { blocosRecebidos = blocos; return '<html>ok</html>'; });
    expect(sqlsChamados.some(s => s.includes('design_project_files'))).toBe(true);
    expect(blocosRecebidos[0]).toMatchObject({ type: 'text' });
  });

  it('sem project_id: não consulta design_project_files', async () => {
    const sqlsChamados: string[] = [];
    const query: DesignQuery = async (sql) => {
      sqlsChamados.push(sql);
      if (sql.includes('FROM designs')) return { rows: [{ tema: 'tema', html: null, historico: [], project_id: null }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    await gerarOuAjustarDesign(query, 1, null, null, async () => '<html>ok</html>');
    expect(sqlsChamados.some(s => s.includes('design_project_files'))).toBe(false);
  });

  it('erro do gerador: grava status erro e mensagem, nunca lança', async () => {
    const { query, updates } = fakePool({ tema: 'tema', html: null, status: 'gerando', historico: [] });
    await expect(gerarOuAjustarDesign(query, 1, null, null, async () => { throw new Error('timeout'); })).resolves.toBeUndefined();
    const upd = updates.find(u => u.sql.includes("status = 'erro'"));
    expect(upd.params.join(' ')).toContain('timeout');
  });

  it('nunca lança mesmo se o UPDATE de erro também falhar (banco fora do ar)', async () => {
    const query: DesignQuery = async (sql) => {
      if (sql.startsWith('SELECT')) return { rows: [{ tema: 'tema', html: null, historico: [] }], rowCount: 1 };
      throw new Error('conexão perdida');
    };
    await expect(gerarOuAjustarDesign(query, 1, null, null, async () => { throw new Error('timeout'); })).resolves.toBeUndefined();
  });
});

describe('limparGerandoPreso', () => {
  it('marca como erro os designs presos em gerando (ex.: depois de um reinício)', async () => {
    const chamadas: any[] = [];
    const query: DesignQuery = async (sql, params) => { chamadas.push({ sql, params }); return { rows: [], rowCount: 2 }; };
    await limparGerandoPreso(query);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].sql).toContain("status = 'erro'");
    expect(chamadas[0].sql).toContain("WHERE status = 'gerando'");
  });
});
