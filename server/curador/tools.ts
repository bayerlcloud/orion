/**
 * Servidor MCP in-process "curadoria": as ÚNICAS tools do agente curador (server/curador/run.ts).
 * Nada aqui confia no modelo: toda validação é do servidor (níveis 0/1 intocáveis, fundir só 4+4,
 * tipos de proposta válidos). A fusão de duplicatas nível 4 é a única ação aplicada direto
 * (nota resultante = maior das duas), registrada numa proposta já aprovada/aplicada para auditoria;
 * todo o resto vira proposta pendente que o Danilo decide no painel.
 * Lógica em funções com pool mockável (tests/curadorTools.test.ts), padrão de decay.ts.
 */
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import { criarProposta, type CurQuery, type TipoProposta } from './proposals.js';

/** Contadores da rodada, para o log final no journal (run.ts). */
export type CuradorStats = { listadas: number; fundidas: number; propostas: number };

export type MemoriaListada = {
  id: number;
  code: string;
  level: number;
  nota: number | null;
  title: string;
  summary: string;
  keywords: string[];
  scope_project_id: number | null;
  scope_user_id: number | null;
  rewritable: boolean;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  last_rewritten_at: string | null;
  body_md?: string;
};

export type ProjetoListado = { id: number; slug: string };

/** Projetos existentes (id + slug): referência para o curador propor reescopo com id válido. */
export async function listarProjetos(q: CurQuery): Promise<ProjetoListado[]> {
  const { rows } = await q('SELECT id, slug FROM projects ORDER BY id');
  return rows as ProjetoListado[];
}

/** Lista as memórias curáveis (níveis 2 a 4). Sem corpo por padrão, para caber no contexto. */
export async function listarMemorias(q: CurQuery, args: { com_corpo?: boolean }): Promise<MemoriaListada[]> {
  const corpo = args.com_corpo ? ', m.body_md' : '';
  const { rows } = await q(
    `SELECT m.id, m.code, m.level, m.nota, m.title, m.summary, m.keywords,
            m.scope_project_id, m.scope_user_id, m.rewritable,
            m.created_at, m.updated_at, m.last_accessed_at, m.last_rewritten_at${corpo}
       FROM memories m
      WHERE m.level BETWEEN 2 AND 4
      ORDER BY m.level ASC, m.nota DESC NULLS LAST, m.id ASC`,
  );
  return rows as MemoriaListada[];
}

export type FundirResult = { mantida: string; removida: string; nota: number };

/**
 * Funde duas duplicatas do enxame: SÓ nível 4 + nível 4. A mantida fica com a maior das duas notas
 * (e com corpo_final, se enviado); a removida morre. Tudo numa transação, com uma proposta já
 * aprovada/aplicada gravada junto, para auditoria no painel.
 */
export async function fundirMicrofatos(
  pool: Pool,
  args: { manter_id: number; remover_id: number; corpo_final?: string },
): Promise<FundirResult> {
  const manter = Number(args.manter_id);
  const remover = Number(args.remover_id);
  if (!Number.isInteger(manter) || !Number.isInteger(remover) || manter <= 0 || remover <= 0) {
    throw new Error('manter_id e remover_id precisam ser inteiros positivos');
  }
  if (manter === remover) throw new Error('manter_id e remover_id precisam ser memórias diferentes');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, code, title, level, nota FROM memories WHERE id = ANY($1) FOR UPDATE',
      [[manter, remover]],
    );
    const rMantem = rows.find((r: any) => r.id === manter);
    const rRemove = rows.find((r: any) => r.id === remover);
    if (!rMantem || !rRemove) throw new Error('memória inexistente (fusão exige as duas vivas)');
    if (rMantem.level !== 4 || rRemove.level !== 4) {
      throw new Error('fusão é exclusiva de micro-fatos: as duas memórias precisam ser nível 4');
    }
    const nota = Math.max(Number(rMantem.nota ?? 1), Number(rRemove.nota ?? 1));
    const corpo = typeof args.corpo_final === 'string' && args.corpo_final.trim() ? args.corpo_final : null;
    await client.query(
      `UPDATE memories SET nota = $2, updated_at = now()
              ${corpo !== null ? ', body_md = $3, last_rewritten_at = now()' : ''}
        WHERE id = $1`,
      corpo !== null ? [manter, nota, corpo] : [manter, nota],
    );
    await client.query('DELETE FROM memories WHERE id = $1', [remover]);
    // Auditoria: uma proposta já aprovada e aplicada, para a fusão aparecer no painel de curadoria.
    const payload = {
      memoria_ids: [manter, remover],
      memorias: [rMantem, rRemove].map((r: any) => ({ id: r.id, code: r.code, title: r.title, level: r.level, nota: r.nota })),
      ...(corpo !== null ? { texto: corpo } : {}),
      justificativa: `fusão automática de duplicatas nível 4 pelo curador: ${rRemove.code} fundida em ${rMantem.code} (nota resultante ${nota})`,
    };
    await client.query(
      `INSERT INTO curadoria_propostas (tipo, payload, status, decided_at, applied_at)
       VALUES ('delecao', $1, 'aprovada', now(), now())`,
      [JSON.stringify(payload)],
    );
    await client.query('COMMIT');
    return { mantida: rMantem.code, removida: rRemove.code, nota };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function texto(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function erro(e: unknown) {
  return { content: [{ type: 'text' as const, text: `erro: ${(e as Error)?.message ?? e}` }], isError: true };
}

/** Servidor MCP do curador. stats acumula os contadores da rodada para o log final. */
export function curadoriaServer(pool: Pool, stats: CuradorStats, log: (msg: string) => void = console.log): McpSdkServerConfigWithInstance {
  const q: CurQuery = (sql, params) => pool.query(sql, params as any[]);
  return createSdkMcpServer({
    name: 'curadoria',
    version: '1.0.0',
    instructions:
      'Curadoria da memória do painel Orion. listar mostra as memórias dos níveis 2 a 4; fundir junta duplicatas nível 4 (aplica direto); propor grava uma proposta que aguarda aprovação humana.',
    tools: [
      tool(
        'listar',
        'Lista as memórias dos níveis 2 a 4 (id, code, nível, nota, título, resumo, keywords, escopo, datas, rewritable) e os projetos existentes (id + slug, para reescopo). Por padrão sem o corpo; use com_corpo apenas quando precisar comparar textos.',
        { com_corpo: z.boolean().optional().describe('true para incluir o body_md de cada memória') },
        async (a) => {
          try {
            const memorias = await listarMemorias(q, a);
            const projetos = await listarProjetos(q);
            stats.listadas = memorias.length;
            return texto({ total: memorias.length, projetos, memorias });
          } catch (e) { return erro(e); }
        },
      ),
      tool(
        'fundir',
        'Funde duas duplicatas claras de MICRO-FATO (nível 4 + nível 4, sem exceção). A mantida herda a maior nota; a removida é excluída. Aplica direto, sem aprovação. corpo_final opcional substitui o corpo da mantida com o texto unificado.',
        {
          manter_id: z.number().int().describe('id da memória que fica'),
          remover_id: z.number().int().describe('id da duplicata que será excluída'),
          corpo_final: z.string().optional().describe('corpo unificado em markdown para a memória mantida'),
        },
        async (a) => {
          try {
            const r = await fundirMicrofatos(pool, a);
            stats.fundidas += 1;
            log(`curador: fundiu ${r.removida} em ${r.mantida} (nota ${r.nota})`);
            return texto({ fundida: true, ...r });
          } catch (e) { return erro(e); }
        },
      ),
      tool(
        'propor',
        'Grava uma proposta de curadoria que AGUARDA aprovação do Danilo no painel. Tipos: promocao (nível 4 nota 10 vira decisão nível 3), reescrita (memória rewritable desatualizada; envie o texto novo completo em texto), delecao (memória nível 2 ou 3 obviamente morta), conflito (duas memórias que se contradizem), reescopo (memória universal que claramente pertence a um projeto específico; envie escopo_novo com um id vindo de listar). Sempre explique na justificativa.',
        {
          tipo: z.enum(['promocao', 'reescrita', 'delecao', 'conflito', 'reescopo']).describe('tipo da proposta'),
          memoria_ids: z.array(z.number().int()).describe('ids das memórias envolvidas'),
          texto: z.string().optional().describe('texto proposto (obrigatório na reescrita)'),
          escopo_novo: z
            .object({
              scope_project_id: z.number().int().positive().optional().describe('id do projeto dono da memória'),
              scope_user_id: z.number().int().positive().optional().describe('id do usuário dono da memória'),
              universal: z.boolean().optional().describe('true para voltar a memória a universal'),
            })
            .optional()
            .describe('só no reescopo: { scope_project_id } OU { scope_user_id } OU { universal: true }'),
          justificativa: z.string().describe('por que esta mudança deve acontecer'),
        },
        async (a) => {
          try {
            const r = await criarProposta(q, a as { tipo: TipoProposta; memoria_ids: number[]; texto?: string; escopo_novo?: unknown; justificativa: string });
            stats.propostas += 1;
            log(`curador: propôs ${r.tipo} para ${r.payload.memorias.map((m) => m.code).join(', ')}`);
            return texto({ proposta: r.id, tipo: r.tipo, status: 'pendente' });
          } catch (e) { return erro(e); }
        },
      ),
    ],
  });
}
