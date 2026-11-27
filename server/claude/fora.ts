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
/** O que o GET devolve: resumo pronto, "gerando" (o front faz polling em /fora) ou nada. */
export type ForaResposta = Fora | { pendente: true; ate_seq: number } | null;
export type ResumoCache = { ate_seq: number; texto: string; gerado_em: string } | null;

export const FORA_PROMPT = [
  'Você resume, para uma pessoa que esteve fora, o que um agente de programação fez numa sessão de trabalho. Vai receber só as mensagens de texto do agente, em ordem.',
  `Responda em português do Brasil, em até ${FORA_LINHAS_MAX} linhas curtas, sem markdown, sem travessão, sem introdução.`,
  'Formato: uma linha "feito: ..." com o que foi concluído; uma linha "pendente: ..." com o que ficou por fazer; e, só se houver algo que depende da pessoa (pergunta, aprovação, decisão), uma linha "precisa de você: ...".',
  'Omita a linha que não se aplica. Não invente nada que não esteja no texto.',
].join('\n');

/**
 * Deve resumir? Só quando a pessoa já viu a sessão alguma vez, há result depois dessa vez e a vez
 * foi há mais de 30 min. `ultimoResultSeq` é o último result da sessão TODA (não só depois de visto_em)
 * e `novo` diz se ele veio depois de visto_em: assim o cache com o mesmo ate_seq vale mesmo depois que
 * a abertura atualizou visto_em (F5, troca de aba, reconexão do SSE), e o card só cai quando a pessoa
 * fecha ou quando um turno novo termina com ela presente (POST /vista depois do result).
 */
export function decidirFora(
  a: { vistoEm: Date | null; ultimoResultSeq: number | null; novo: boolean; cache: ResumoCache; now?: Date },
): { acao: 'nada' } | { acao: 'cache'; fora: Fora } | { acao: 'gerar'; ateSeq: number } {
  const { vistoEm, ultimoResultSeq, cache } = a;
  if (ultimoResultSeq == null || !vistoEm) return { acao: 'nada' };
  if (cache && cache.ate_seq === ultimoResultSeq) return cache.texto ? { acao: 'cache', fora: { texto: cache.texto, ate_seq: cache.ate_seq } } : { acao: 'nada' };
  if (!a.novo) return { acao: 'nada' };
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

/** Chama o Haiku (20 s). Exceção/timeout propaga (quem gera não grava cache e a próxima abertura tenta de novo). */
export async function resumirFora(entrada: string, token: string | null): Promise<string> {
  if (!entrada.trim()) return '';
  return limparResumo(await haikuUmTurno(entrada, FORA_PROMPT, token, FORA_TIMEOUT_MS));
}

/** Marca que a pessoa viu a sessão agora. */
export async function marcarVista(pool: Pool, sessionId: string, userId: number): Promise<void> {
  await pool.query(
    `INSERT INTO claude_session_vistas (session_id, user_id, visto_em) VALUES ($1, $2, now())
     ON CONFLICT (session_id, user_id) DO UPDATE SET visto_em = now()`, [sessionId, userId]);
}

/** Gerações em voo por sessão+pessoa: recarregar a página durante os 20 s não chama o modelo duas vezes. */
const emVoo = new Map<string, Promise<void>>();
const chave = (sessionId: string, userId: number) => `${sessionId}:${userId}`;
/** Promessa da geração em voo (testes esperam por ela); undefined = nada gerando. */
export const foraEmVoo = (sessionId: string, userId: number) => emVoo.get(chave(sessionId, userId));

/**
 * O que o GET da sessão devolve em `fora`. Abrir a sessão é o caminho mais quente do painel, então o
 * modelo NUNCA segura a resposta: quando precisa gerar, dispara em segundo plano e responde
 * `{ pendente: true }`; o front faz polling em GET /fora. `gerar` só quando a pessoa está abrindo de
 * fato (reconexão do SSE e script só enxergam cache ou voo).
 */
export async function foraDaSessao(
  pool: Pool, sessionId: string, userId: number,
  opts: { gerar: boolean; token: () => Promise<string | null>; resumir?: typeof resumirFora },
): Promise<ForaResposta> {
  const { rows: [v] } = await pool.query<{ visto_em: Date; resumo: ResumoCache }>(
    'SELECT visto_em, resumo FROM claude_session_vistas WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  if (!v) return null;
  // Último result da sessão toda + se ele é posterior ao visto_em (ver decidirFora).
  const { rows: [r] } = await pool.query<{ seq: number | null; novo: boolean | null }>(
    `SELECT max(seq)::int AS seq, max(ts) > $2 AS novo FROM claude_events WHERE session_id = $1 AND type = 'result'`, [sessionId, v.visto_em]);
  const d = decidirFora({ vistoEm: v.visto_em, ultimoResultSeq: r?.seq ?? null, novo: !!r?.novo, cache: v.resumo });
  if (d.acao === 'nada') return null;
  if (d.acao === 'cache') return d.fora;
  const k = chave(sessionId, userId);
  if (emVoo.has(k)) return { pendente: true, ate_seq: d.ateSeq };
  if (!opts.gerar) return null;
  const vistoEm = v.visto_em;
  const gerar = (async () => {
    // Só os blocos de texto do assistant já saem do Postgres: payload inteiro de milhares de eventos pesava no heap.
    const { rows: eventos } = await pool.query<EventoLeve>(
      `SELECT e.type, jsonb_build_object('message', jsonb_build_object('content',
                (SELECT jsonb_agg(b ORDER BY o) FROM jsonb_array_elements(e.payload->'message'->'content') WITH ORDINALITY AS x(b, o) WHERE b->>'type' = 'text'))) AS payload
         FROM claude_events e
        WHERE e.session_id = $1 AND e.type = 'assistant' AND e.ts > $2 AND e.seq <= $3
          AND jsonb_typeof(e.payload->'message'->'content') = 'array'
        ORDER BY e.seq`, [sessionId, vistoEm, d.ateSeq]);
    const texto = await (opts.resumir ?? resumirFora)(montarEntrada(eventos), await opts.token());
    // Resposta vazia do modelo grava '' mesmo: ate_seq igual evita tentar de novo a cada abertura até
    // haver turno novo. Exceção/timeout não chega aqui (catch abaixo), então aí sim tenta de novo.
    await pool.query(
      `UPDATE claude_session_vistas SET resumo = $3::jsonb WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId, JSON.stringify({ ate_seq: d.ateSeq, texto, gerado_em: new Date().toISOString() })]);
  })().catch(() => { /* falhou: sem card; a próxima abertura tenta de novo */ }).finally(() => emVoo.delete(k));
  emVoo.set(k, gerar);
  return { pendente: true, ate_seq: d.ateSeq };
}

/** GET /fora (polling do front): só leitura. Em voo = pendente; cache com texto = resumo; senão null. */
export async function cacheFora(pool: Pool, sessionId: string, userId: number): Promise<Fora | { pendente: true } | null> {
  if (emVoo.has(chave(sessionId, userId))) return { pendente: true };
  const { rows: [v] } = await pool.query<{ resumo: ResumoCache }>(
    'SELECT resumo FROM claude_session_vistas WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  const c = v?.resumo;
  return c?.texto ? { texto: c.texto, ate_seq: c.ate_seq } : null;
}
