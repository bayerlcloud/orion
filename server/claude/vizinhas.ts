/**
 * Sessões vizinhas (tarefa C2, 27/11/2026): outras sessões do MESMO projeto com atividade nos últimos
 * 30 min e os arquivos que cada uma editou nesse intervalo. Vai no system append de cada turno para
 * o Claude saber que outra pessoa (ou outro agente) está mexendo nos mesmos arquivos.
 *
 * Uma query por projeto, com cache de 20 s: vários turnos começando juntos não repetem a leitura.
 */
import type { Pool } from 'pg';

export const JANELA_MIN = 30;
export const ARQUIVOS_MAX = 8;
const CACHE_MS = 20_000;
/** Tools do SDK que escrevem em arquivo; o caminho vem em input.file_path (NotebookEdit: notebook_path). */
export const TOOLS_EDICAO = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export type SessaoVizinha = {
  id: string;
  title: string;
  pessoa: string;
  privada: boolean;
  emTurno: boolean;
  /** Minutos desde a última atividade (updated_at); só faz sentido quando não está em turno. */
  paradaMin: number;
  /** Caminhos já relativos ao projeto (sem o prefixo da worktree da sessão nem da raiz do projeto). */
  arquivos: string[];
};

/** Caminhos editados num evento `assistant` do SDK (payload.message.content[] com tool_use de Edit/Write...). */
export function arquivosEditados(payload: unknown): string[] {
  const content = (payload as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as { type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } }[]) {
    if (c?.type !== 'tool_use' || !TOOLS_EDICAO.has(c.name ?? '')) continue;
    const p = c.input?.file_path ?? c.input?.notebook_path;
    if (typeof p === 'string' && p) out.push(p);
  }
  return out;
}

/** Tira o prefixo da worktree (ou da raiz do projeto) para o caminho ficar relativo ao projeto. */
export function relativoAoProjeto(caminho: string, prefixos: (string | null | undefined)[]): string {
  for (const pre of prefixos) {
    const base = (pre ?? '').replace(/\/+$/, '');
    if (base && caminho.startsWith(base + '/')) return caminho.slice(base.length + 1);
  }
  return caminho;
}

/** Bloco do system append; string vazia quando não há vizinha (sem custo de tokens). */
export function vizinhasParaHeader(linhas: SessaoVizinha[] | null | undefined): string {
  if (!linhas?.length) return '';
  const out = [`Outras sessões ativas neste projeto (últimos ${JANELA_MIN} min). Antes de editar um arquivo listado aqui, releia-o do disco e avise quem está na sessão:`];
  for (const v of linhas) {
    if (v.privada) { out.push(`- sessão privada de ${v.pessoa}`); continue; }
    const status = v.emTurno ? 'em turno agora' : `parada há ${v.paradaMin} min`;
    const arqs = v.arquivos.slice(0, ARQUIVOS_MAX);
    const resto = v.arquivos.length - arqs.length;
    const lista = arqs.length ? `; editou: ${arqs.join(', ')}${resto > 0 ? ` +${resto}` : ''}` : '; não editou arquivos';
    out.push(`- "${v.title}" (${v.pessoa}, ${status})${lista}`);
  }
  return out.join('\n');
}

type Linha = { id: string; title: string; pessoa: string; private: boolean; status: string; parada_min: number; cwd: string; project_path: string | null; arquivos: string[] };
const cache = new Map<number, { ts: number; linhas: Promise<Linha[]> }>();

function consultar(pool: Pool, projectId: number): Promise<Linha[]> {
  // claude_events só tem índice em (session_id, seq): o filtro por ts varre os eventos das sessões
  // ativas do projeto (poucas). Se pesar, índice em (session_id, ts).
  return pool.query<Linha>(
    `WITH ativas AS (
       SELECT s.id, s.title, s.cwd, s.private, s.status, u.name AS pessoa, p.path AS project_path,
              floor(extract(epoch FROM now() - s.updated_at) / 60)::int AS parada_min
         FROM claude_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.project_id = $1 AND NOT s.archived
          AND (s.status = 'running' OR s.updated_at > now() - make_interval(mins => $2)))
     SELECT a.*, COALESCE(array_agg(DISTINCT COALESCE(c->'input'->>'file_path', c->'input'->>'notebook_path'))
                           FILTER (WHERE c IS NOT NULL), '{}') AS arquivos
       FROM ativas a
       LEFT JOIN claude_events e ON e.session_id = a.id AND e.type = 'assistant' AND e.ts > now() - make_interval(mins => $2)
       LEFT JOIN LATERAL jsonb_array_elements(e.payload->'message'->'content') c
              ON c->>'type' = 'tool_use' AND c->>'name' IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')
      GROUP BY a.id, a.title, a.cwd, a.private, a.status, a.pessoa, a.project_path, a.parada_min
      ORDER BY a.parada_min`, [projectId, JANELA_MIN]).then(r => r.rows);
}

/** Outras sessões ativas do projeto (exclui a própria). Erro de banco vira lista vazia: o turno não pode parar por isso. */
export async function sessoesVizinhas(pool: Pool, projectId: number | null, sessionId: string): Promise<SessaoVizinha[]> {
  if (projectId == null) return [];
  const agora = Date.now();
  let hit = cache.get(projectId);
  if (!hit || agora - hit.ts > CACHE_MS) {
    hit = { ts: agora, linhas: consultar(pool, projectId).catch(() => [] as Linha[]) };
    cache.set(projectId, hit);
  }
  const linhas = await hit.linhas;
  return linhas.filter(l => l.id !== sessionId).map(l => ({
    id: l.id, title: l.title, pessoa: l.pessoa, privada: !!l.private, emTurno: l.status === 'running', paradaMin: Math.max(0, l.parada_min),
    arquivos: (l.arquivos ?? []).filter(a => a && a !== 'null').map(a => relativoAoProjeto(a, [l.cwd, l.project_path])),
  }));
}
