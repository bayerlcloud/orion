// Custo e qualidade por projeto e por pessoa (Dash). A forma da resposta sai de montarQualidade (pura, testada).

export type LinhaQualidade = {
  nome: string | null;
  sessoes: number | string; turnos: number | string; tokens_in: number | string; tokens_out: number | string;
  compactacoes: number | string; cortados: number | string; publicacoes: number | string; erros: number | string;
};
export type Qualidade = Omit<Record<keyof LinhaQualidade, number>, 'nome'> & { nome: string };
export type QualidadeResposta = { dias: 7 | 30; por_projeto: Qualidade[]; por_pessoa: Qualidade[]; total: Qualidade };

const CAMPOS = ['sessoes', 'turnos', 'tokens_in', 'tokens_out', 'compactacoes', 'cortados', 'publicacoes', 'erros'] as const;

export function diasValidos(v: unknown): 7 | 30 { return Number(v) === 30 ? 30 : 7; }

// pg devolve bigint/numeric como string; nome nulo vira "(sem projeto)" ou "(sem pessoa)".
function normaliza(l: LinhaQualidade, vazio: string): Qualidade {
  const o = { nome: l.nome ?? vazio } as Qualidade;
  for (const c of CAMPOS) o[c] = Number(l[c]) || 0;
  return o;
}

const ordem = (a: Qualidade, b: Qualidade) => b.tokens_out - a.tokens_out || a.nome.localeCompare(b.nome);

export function montarQualidade(dias: 7 | 30, projetos: LinhaQualidade[], pessoas: LinhaQualidade[]): QualidadeResposta {
  const por_projeto = projetos.map(l => normaliza(l, '(sem projeto)')).sort(ordem);
  const por_pessoa = pessoas.map(l => normaliza(l, '(sem pessoa)')).sort(ordem);
  // Cada sessão cai em exatamente um projeto, então a soma dos projetos é o total.
  const total = { nome: 'Total' } as Qualidade;
  for (const c of CAMPOS) total[c] = por_projeto.reduce((s, r) => s + r[c], 0);
  return { dias, por_projeto, por_pessoa, total };
}

/**
 * Uma consulta por dimensão. As sessões tocadas no período (updated_at, indexado) limitam a leitura de
 * claude_events, que não tem índice em ts; os eventos ainda são filtrados por ts. Tokens e turnos são os
 * acumulados da sessão tocada.
 */
export function sqlQualidade(dim: 'projeto' | 'pessoa'): string {
  const join = dim === 'projeto' ? 'LEFT JOIN projects d ON d.id = s.project_id' : 'LEFT JOIN users d ON d.id = s.user_id';
  return `WITH s AS (SELECT * FROM claude_sessions WHERE updated_at > now() - $1::int * interval '1 day'),
ev AS (
  SELECT e.session_id,
    count(*) FILTER (WHERE e.type = 'system' AND e.payload->>'subtype' = 'compact_boundary') AS compactacoes,
    count(*) FILTER (WHERE e.type = 'user_prompt' AND e.payload->>'prompt' LIKE '[Orion] O servidor do Orion reiniciou%') AS cortados,
    count(*) FILTER (WHERE e.type = 'assistant' AND jsonb_path_exists(e.payload, '$.message.content[*] ? (@.type == "tool_use" && @.name like_regex "^mcp__orion-publicar__")')) AS publicacoes,
    count(*) FILTER (WHERE e.type = 'error') AS erros
  FROM s JOIN claude_events e ON e.session_id = s.id
  WHERE e.ts > now() - $1::int * interval '1 day'
  GROUP BY e.session_id)
SELECT d.name AS nome, count(*) AS sessoes, sum(s.turns) AS turnos, sum(s.input_tokens) AS tokens_in, sum(s.output_tokens) AS tokens_out,
  sum(coalesce(ev.compactacoes, 0)) AS compactacoes, sum(coalesce(ev.cortados, 0)) AS cortados,
  sum(coalesce(ev.publicacoes, 0)) AS publicacoes, sum(coalesce(ev.erros, 0)) AS erros
FROM s LEFT JOIN ev ON ev.session_id = s.id ${join}
GROUP BY d.name`;
}
