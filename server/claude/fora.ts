/**
 * "Enquanto você estava fora" (tarefa C3, 27/11/2026): a pessoa volta no dia seguinte a uma sessão
 * em que o agente rodou horas e não sabe o que aconteceu. Ao abrir a sessão, se houve turno concluído
 * (evento `result`) depois da última vez que ELA viu a sessão, e essa vez foi há mais de 30 minutos,
 * um Haiku resume em até 3 linhas o que foi feito e o que ficou pendente.
 *
 * "Última vez que viu" é por pessoa e sessão em `claude_session_vistas` (migration 023): o GET da
 * sessão com `?abrindo=1` e o POST /vista (fim de turno com a aba ativa) atualizam `visto_em`. O
 * resumo fica em cache na mesma linha (`resumo` jsonb: ate_seq, texto, gerado_em) porque depende do
 * visto_em de cada pessoa; só regenera quando há result novo depois de ate_seq.
 *
 * Lógica em funções puras (tests/fora.test.ts); o modelo entra só em `resumirFora`, injetável.
 */
import type { Pool } from 'pg';
import { haikuUmTurno } from './titulo.js';

export const FORA_AUSENCIA_MIN_MS = 30 * 60 * 1000;
export const FORA_ENTRADA_MAX = 6000;
export const FORA_LINHAS_MAX = 3;
export const FORA_TIMEOUT_MS = 20_000;

export type Fora = { texto: string; ate_seq: number };
export type ResumoCache = { ate_seq: number; texto: string; gerado_em: string } | null;

export const FORA_PROMPT = [
  'Você resume, para uma pessoa que esteve fora, o que um agente de programação fez numa sessão de trabalho. Vai receber só as mensagens de texto do agente, em ordem.',
  `Responda em português do Brasil, em até ${FORA_LINHAS_MAX} linhas curtas, sem markdown, sem travessão, sem introdução.`,
  'Formato: uma linha "feito: ..." com o que foi concluído; uma linha "pendente: ..." com o que ficou por fazer; e, só se houver algo que depende da pessoa (pergunta, aprovação, decisão), uma linha "precisa de você: ...".',
  'Omita a linha que não se aplica. Não invente nada que não esteja no texto.',
].join('\n');

/**
 * Deve resumir? Só quando a pessoa já viu a sessão alguma vez, há result depois dessa vez e a vez
 * foi há mais de 30 min. Cache válido (mesmo ate_seq) dispensa o modelo e vale mesmo com visto_em
 * recente: o card fica até a pessoa fechar ou chegarem turnos novos.
 */
export function decidirFora(
  a: { vistoEm: Date | null; ultimoResultSeq: number | null; cache: ResumoCache; now?: Date },
): { acao: 'nada' } | { acao: 'cache'; fora: Fora } | { acao: 'gerar'; ateSeq: number } {
  const { vistoEm, ultimoResultSeq, cache } = a;
  if (ultimoResultSeq == null || !vistoEm) return { acao: 'nada' };
  if (cache && cache.ate_seq === ultimoResultSeq) return cache.texto ? { acao: 'cache', fora: { texto: cache.texto, ate_seq: cache.ate_seq } } : { acao: 'nada' };
  const now = a.now ?? new Date();
  if (now.getTime() - vistoEm.getTime() < FORA_AUSENCIA_MIN_MS) return { acao: 'nada' };
  return { acao: 'gerar', ateSeq: ultimoResultSeq };
}

type EventoLeve = { type: string; payload: unknown };

/** Só o texto do assistant (sem tool_use, sem thinking), em ordem; passou do teto, fica o FIM. */
export function montarEntrada(eventos: EventoLeve[], max = FORA_ENTRADA_MAX): string {
  const partes: string[] = [];
  for (const e of eventos) {
    if (e.type !== 'assistant') continue;
    const content = (e.payload as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as { type?: string; text?: string }[]) {
      const t = b?.type === 'text' ? (b.text ?? '').trim() : '';
      if (t) partes.push(t);
    }
  }
  const texto = partes.join('\n');
  return texto.length > max ? texto.slice(-max) : texto;
}

/** Limpa a resposta do modelo: sem linhas vazias, sem marcador de lista, no máximo 3 linhas. Vazio = não mostrar. */
export function limparResumo(texto: string, max = FORA_LINHAS_MAX): string {
  return texto.split('\n')
    .map(l => l.replace(/^\s*[-*•]\s*/, '').replace(/[—–]/g, ',').trim())
    .filter(Boolean)
    .slice(0, max)
    .join('\n');
}

/** Chama o Haiku (20 s). Qualquer falha vira '' e o card simplesmente não aparece. */
export async function resumirFora(entrada: string, token: string | null): Promise<string> {
  if (!entrada.trim()) return '';
  try { return limparResumo(await haikuUmTurno(entrada, FORA_PROMPT, token, FORA_TIMEOUT_MS)); }
  catch { return ''; }
}

/** Marca que a pessoa viu a sessão agora. */
export async function marcarVista(pool: Pool, sessionId: string, userId: number): Promise<void> {
  await pool.query(
    `INSERT INTO claude_session_vistas (session_id, user_id, visto_em) VALUES ($1, $2, now())
     ON CONFLICT (session_id, user_id) DO UPDATE SET visto_em = now()`, [sessionId, userId]);
}

/**
 * O que o GET da sessão devolve em `fora`. `gerar` só quando a pessoa está abrindo de fato (senão
 * leitura por script ou reconexão do SSE custaria uma chamada ao modelo); sem gerar, vale só o cache.
 */
export async function foraDaSessao(
  pool: Pool, sessionId: string, userId: number,
  opts: { gerar: boolean; token: () => Promise<string | null>; resumir?: typeof resumirFora },
): Promise<Fora | null> {
  const { rows: [v] } = await pool.query<{ visto_em: Date; resumo: ResumoCache }>(
    'SELECT visto_em, resumo FROM claude_session_vistas WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  if (!v) return null;
  const { rows: [r] } = await pool.query<{ seq: number | null }>(
    `SELECT max(seq)::int AS seq FROM claude_events WHERE session_id = $1 AND type = 'result' AND ts > $2`, [sessionId, v.visto_em]);
  const d = decidirFora({ vistoEm: v.visto_em, ultimoResultSeq: r?.seq ?? null, cache: v.resumo });
  if (d.acao === 'nada') return null;
  if (d.acao === 'cache') return d.fora;
  if (!opts.gerar) return null;
  // Só os blocos de texto do assistant já saem do Postgres: payload inteiro de milhares de eventos pesava no heap.
  const { rows: eventos } = await pool.query<EventoLeve>(
    `SELECT e.type, jsonb_build_object('message', jsonb_build_object('content',
              (SELECT jsonb_agg(b ORDER BY o) FROM jsonb_array_elements(e.payload->'message'->'content') WITH ORDINALITY AS x(b, o) WHERE b->>'type' = 'text'))) AS payload
       FROM claude_events e
      WHERE e.session_id = $1 AND e.type = 'assistant' AND e.ts > $2 AND e.seq <= $3
        AND jsonb_typeof(e.payload->'message'->'content') = 'array'
      ORDER BY e.seq`, [sessionId, v.visto_em, d.ateSeq]);
  const texto = await (opts.resumir ?? resumirFora)(montarEntrada(eventos), await opts.token());
  // Grava mesmo vazio: ate_seq igual evita tentar o modelo de novo a cada abertura até haver turno novo.
  await pool.query(
    `UPDATE claude_session_vistas SET resumo = $3::jsonb WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId, JSON.stringify({ ate_seq: d.ateSeq, texto, gerado_em: new Date().toISOString() })]);
  return texto ? { texto, ate_seq: d.ateSeq } : null;
}
