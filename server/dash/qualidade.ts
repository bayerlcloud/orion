// Custo e qualidade por projeto e por pessoa (Dash). A forma da resposta sai de montarQualidade (pura, testada).

const CAMPOS = ['sessoes', 'turnos', 'tokens_in', 'tokens_out', 'compactacoes', 'cortados', 'publicacoes', 'erros'] as const;

export type LinhaQualidade = { projeto: string | null; pessoa: string | null } & Record<(typeof CAMPOS)[number], number | string>;
export type Qualidade = { nome: string } & Record<(typeof CAMPOS)[number], number>;
export type QualidadeResposta = { dias: 7 | 30; por_projeto: Qualidade[]; por_pessoa: Qualidade[]; total: Qualidade };


export function diasValidos(v: unknown): 7 | 30 { return Number(v) === 30 ? 30 : 7; }

// Soma as linhas (projeto x pessoa) agrupando por uma das chaves; pg devolve bigint/numeric como string.
function agrupa(linhas: LinhaQualidade[], chave: 'projeto' | 'pessoa', vazio: string): Qualidade[] {
  const m = new Map<string, Qualidade>();
  for (const l of linhas) {
    const nome = l[chave] ?? vazio;
    const o = m.get(nome) ?? (Object.fromEntries([['nome', nome], ...CAMPOS.map(c => [c, 0])]) as Qualidade);
    for (const c of CAMPOS) o[c] += Number(l[c]) || 0;
    m.set(nome, o);
  }
  return [...m.values()].sort((a, b) => b.tokens_out - a.tokens_out || a.nome.localeCompare(b.nome));
}

export function montarQualidade(dias: 7 | 30, linhas: LinhaQualidade[]): QualidadeResposta {
  const por_projeto = agrupa(linhas, 'projeto', '(sem projeto)');
  const por_pessoa = agrupa(linhas, 'pessoa', '(sem pessoa)');
  // As duas dimensões particionam as mesmas linhas, então o total fecha por construção.
  const total = Object.fromEntries([['nome', 'Total'], ...CAMPOS.map(c => [c, por_projeto.reduce((t, r) => t + r[c], 0)])]) as Qualidade;
  return { dias, por_projeto, por_pessoa, total };
}

/**
 * Uma consulta só, agrupada por projeto x pessoa (montarQualidade reagrupa em memória). As sessões tocadas no
 * período (updated_at, indexado) limitam a leitura de claude_events, que não tem índice em ts.
 * Tokens e turnos vêm dos eventos `result` do período (campo `usage`, por turno), NÃO de claude_sessions.*_tokens:
 * esses somam o modelUsage do result a cada turno, que já é acumulado da sessão, e crescem quadraticamente.
 * Entrada = input + cache_read + cache_creation (mesma conta de server/curador/extrator.ts).
 */
export const SQL_QUALIDADE = `WITH s AS (SELECT id, project_id, user_id FROM claude_sessions WHERE updated_at > now() - $1::int * interval '1 day'),
ev AS (
  SELECT e.session_id,
    count(*) FILTER (WHERE e.type = 'result') AS turnos,
    sum(coalesce((e.payload->'usage'->>'input_tokens')::bigint, 0) + coalesce((e.payload->'usage'->>'cache_read_input_tokens')::bigint, 0)
      + coalesce((e.payload->'usage'->>'cache_creation_input_tokens')::bigint, 0)) FILTER (WHERE e.type = 'result') AS tokens_in,
    sum(coalesce((e.payload->'usage'->>'output_tokens')::bigint, 0)) FILTER (WHERE e.type = 'result') AS tokens_out,
    count(*) FILTER (WHERE e.type = 'system' AND e.payload->>'subtype' = 'compact_boundary') AS compactacoes,
    count(*) FILTER (WHERE e.type = 'user_prompt' AND e.payload->>'prompt' LIKE '[Orion] O servidor do Orion reiniciou%') AS cortados,
    count(*) FILTER (WHERE e.type = 'assistant' AND jsonb_path_exists(e.payload, '$.message.content[*] ? (@.type == "tool_use" && @.name like_regex "^mcp__orion-publicar__")')) AS publicacoes,
    count(*) FILTER (WHERE e.type = 'error') AS erros
  FROM s JOIN claude_events e ON e.session_id = s.id
  WHERE e.ts > now() - $1::int * interval '1 day'
  GROUP BY e.session_id)
SELECT p.name AS projeto, u.name AS pessoa, count(*) AS sessoes,
  sum(coalesce(ev.turnos, 0)) AS turnos, sum(coalesce(ev.tokens_in, 0)) AS tokens_in, sum(coalesce(ev.tokens_out, 0)) AS tokens_out,
  sum(coalesce(ev.compactacoes, 0)) AS compactacoes, sum(coalesce(ev.cortados, 0)) AS cortados,
  sum(coalesce(ev.publicacoes, 0)) AS publicacoes, sum(coalesce(ev.erros, 0)) AS erros
FROM s LEFT JOIN ev ON ev.session_id = s.id
LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN users u ON u.id = s.user_id
GROUP BY p.name, u.name`;
