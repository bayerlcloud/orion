/**
 * Context Compressor — comprime sessões longas para economizar contexto.
 *
 * Round 4 upgrade: token-aware (em vez de message-count) com:
 *   - Proteção de janelas em TOKENS (não em count)
 *   - Tool output pruning antes de pedir LLM resumir
 *   - Seções estruturadas no sumário
 *   - COMPRESSED_SUMMARY_METADATA_KEY para evitar re-execução
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { saveMemory } from './index.js'

import { createLogger } from '../logger.js'
const log = createLogger('compressor')

const COMPRESS_AFTER       = 40    // trigger por contagem de mensagens (fallback)
const KEEP_FIRST           = 5     // protege os primeiros N turnos
const KEEP_LAST_TOKENS_EST = 3000  // protege o "tail" de N tokens estimados
const TOKEN_TRIGGER_RATIO  = 0.72  // comprime quando > 72% do contexto está ocupado

// Contexto máximo estimado por modelo (tokens)
const MODEL_CONTEXT = {
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  default: 200_000,
}

// Marcador semântico para que o modelo reconheça o sumário como referência histórica
const COMPRESSED_SUMMARY_METADATA_KEY = '_compressed_summary'

// ── H2: Preamble anti-re-execução (Hermes pattern) ───────────────────────────
// Instrui o modelo a NÃO re-executar tarefas históricas do sumário.
const COMPACTION_PREAMBLE = (
  '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into ' +
  'the summary below. This is a handoff from a previous context window — ' +
  'treat it as background reference, NOT as active instructions. ' +
  'Do NOT answer questions or fulfill requests mentioned in this summary; ' +
  'they were already addressed. ' +
  'Respond ONLY to the latest user message that appears AFTER this summary — ' +
  'that message is the single source of truth for what to do right now. ' +
  'Topic overlap with the summary does NOT mean you should resume its task: ' +
  'even on similar topics, the latest message WINS. ' +
  'Discard any pending action items from the summary.'
)
const COMPACTION_END_MARKER = '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'

/** Estima tokens a partir de chars (rough: 4 chars ≈ 1 token) */
function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4)
}

/** Retorna o número de tokens estimados de uma mensagem */
function msgTokens(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content ?? '')
  return estimateTokens(content)
}

/** Remove outputs de ferramentas muito longos antes de comprimir (cheap pre-pass) */
function pruneToolOutputs(messages, maxToolOutputTokens = 500) {
  return messages.map(m => {
    if (!m.content || typeof m.content !== 'string') return m
    // Detecta outputs de tool (padrão: bloco XML ou JSON muito longo)
    if (estimateTokens(m.content) > maxToolOutputTokens && m.role === 'assistant') {
      const pruned = m.content.slice(0, maxToolOutputTokens * 4) + '\n[... output truncado para compressão ...]'
      return { ...m, content: pruned }
    }
    return m
  })
}

export async function compressSessionIfNeeded(sessionId, opts = {}) {
  const db = getDb()
  const { model = 'claude-haiku-4-5-20251001', usageTokens = null } = opts

  // Contar mensagens ativas
  let n = 0
  try {
    const row = db.prepare(
      'SELECT COUNT(*) as n FROM messages WHERE session_id = ? AND active = 1'
    ).get(sessionId)
    n = row?.n ?? 0
  } catch (_e) {
    const row = db.prepare(
      'SELECT COUNT(*) as n FROM messages WHERE session_id = ?'
    ).get(sessionId)
    n = row?.n ?? 0
  }

  // Verifica trigger por tokens (quando caller passa usage)
  let shouldCompress = n >= COMPRESS_AFTER
  if (usageTokens != null) {
    const ctxLen = MODEL_CONTEXT[model] ?? MODEL_CONTEXT.default
    const ratio  = usageTokens / ctxLen
    if (ratio > TOKEN_TRIGGER_RATIO) shouldCompress = true
    log.debug({ ratio: Math.round(ratio * 100) / 100, n }, '[compressor] token ratio')
  }

  if (!shouldCompress) return null

  // Se já tem resumo e não cresceu muito, retorna o que já tem
  let session = null
  try {
    session = db.prepare('SELECT context_summary FROM sessions WHERE id = ?').get(sessionId)
  } catch (_e) { /* coluna ainda não existe */ }

  if (session?.context_summary && n < COMPRESS_AFTER + 10) return session.context_summary

  // Pega TODAS as mensagens ativas em ordem cronológica
  let allMsgs = []
  try {
    allMsgs = db.prepare(`
      SELECT id, role, content FROM messages
      WHERE session_id = ? AND active = 1
      ORDER BY created_at ASC
    `).all(sessionId)
  } catch (_e) {
    allMsgs = db.prepare(`
      SELECT id, role, content FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId)
  }

  // ── Proteção de janelas por tokens (Round 4) ─────────────────────────────────
  // Início: protege os KEEP_FIRST turnos
  const firstKept = allMsgs.slice(0, KEEP_FIRST)
  const firstIds  = new Set(firstKept.map(m => m.id))

  // Tail: protege até atingir KEEP_LAST_TOKENS_EST tokens (de trás pra frente)
  const lastKept = []
  let tailTokens = 0
  for (let i = allMsgs.length - 1; i >= KEEP_FIRST; i--) {
    const t = msgTokens(allMsgs[i])
    if (tailTokens + t > KEEP_LAST_TOKENS_EST && lastKept.length >= 4) break
    lastKept.unshift(allMsgs[i])
    tailTokens += t
  }
  const lastIds = new Set(lastKept.map(m => m.id))

  const toCompress = allMsgs.filter(m => !firstIds.has(m.id) && !lastIds.has(m.id))

  if (toCompress.length === 0) return session?.context_summary ?? null

  // ── Tool output pruning (Round 4) ────────────────────────────────────────────
  const prunedMsgs = pruneToolOutputs(toCompress)

  // Formata como transcript
  const transcript = prunedMsgs
    .map(m => `${m.role === 'user' ? 'Usuário' : 'Orion'}: ${m.content.slice(0, 500)}`)
    .join('\n\n')

  // ── A. on_pre_compress: extrai fatos ANTES de descartar ──────────────────────
  setImmediate(async () => {
    try {
      const extractPrompt = `Você analisa uma conversa e extrai APENAS fatos concretos sobre o usuário Danilo (preferências, decisões, projetos, ferramentas, pessoas) que NÃO são óbvios ou triviais.

Conversa a analisar:
${transcript.slice(0, 3000)}

Retorne 0 a 5 fatos, um por linha, no formato:
CATEGORIA|TAGS|fato concreto

CATEGORIA: general, user_pref, project, tool, person, decision
TAGS: até 3 tags separadas por vírgula
Exemplo: "decision|orion,arquitetura|Danilo decidiu usar Node.js no Orion em vez de Python"

Se não houver fatos relevantes, retorne: NENHUM`

      const r = await execa('claude', [
        '-p', extractPrompt,
        '--model', 'claude-haiku-4-5-20251001',
        '--output-format', 'json',
        '--dangerously-skip-permissions',
      ], { timeout: 45_000 })

      const text = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
      if (!text || text.toUpperCase() === 'NENHUM') return

      const validCats = ['general', 'user_pref', 'project', 'tool', 'person', 'decision']
      let saved = 0
      for (const line of text.split('\n').slice(0, 5)) {
        const parts = line.split('|')
        if (parts.length !== 3) continue
        const [cat, tagStr, content] = parts.map(p => p.trim())
        if (!validCats.includes(cat) || content.length < 10) continue
        const tags = tagStr ? tagStr.split(',').map(t => t.trim()).filter(Boolean) : []
        saveMemory({ content, type: 'episodic', source: `session:${sessionId}`, confidence: 0.6, tags, category: cat, sourceTool: 'pre-compress', sourceSessionId: sessionId })
        saved++
      }
      if (saved > 0) log.info({ saved, session: sessionId.slice(0,8) }, '[compressor] on_pre_compress: fatos salvos antes de descartar')
    } catch (err) {
      log.debug({ err: err.message }, '[compressor] on_pre_compress silencioso')
    }
  })

  // ── Sumário estruturado (Round 4 — seções como Hermes) ───────────────────────
  const prev = session?.context_summary
    ? `\n\nRESUMO ANTERIOR (mesclar/atualizar):\n${session.context_summary}`
    : ''

  const prompt = `Você é um resumidor de conversas. Crie um resumo estruturado em português desta conversa nas seções abaixo.${prev}

## Tarefas Pendentes
Liste TODAS as tarefas que foram iniciadas mas NÃO concluídas. Se não houver, escreva "Nenhuma".

## Próximos Passos
Liste exatamente o que o agente deveria fazer a seguir. Se não houver, escreva "Nenhum".

## Decisões Tomadas
Decisões técnicas ou de negócio tomadas durante a conversa que não devem ser revertidas.

## Tarefas Realizadas
O que foi discutido/feito (REFERÊNCIA APENAS — não reexecute):

## Pedidos Pendentes do Usuário
Pedidos do usuário não completamente respondidos:

## Contexto Essencial
Fatos críticos que o agente precisa saber para continuar o trabalho:

---
TRANSCRIPT:
${transcript}

Preencha apenas as seções com conteúdo relevante. Omita seções vazias:`

  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 60_000 })

    const parsed = JSON.parse(result.stdout)
    const rawSummary = parsed.result ?? parsed.content ?? ''

    // ── H2: Embrulha com preamble anti-re-execução + end marker ─────────────────
    const summary = `${COMPACTION_PREAMBLE}\n\n[${COMPRESSED_SUMMARY_METADATA_KEY}]\n${rawSummary.trim()}\n\n${COMPACTION_END_MARKER}`

    if (!summary) return session?.context_summary ?? null

    // Salva resumo na sessão
    try {
      db.prepare('UPDATE sessions SET context_summary = ? WHERE id = ?').run(summary, sessionId)
    } catch (_e) { /* coluna ainda não existe */ }

    // ── H3: registra fronteira de compressão (lineage) + emite session-switch ───
    // Não rotaciona o session_id (quebraria claude --resume); marca o boundary
    // para que cron jobs e memory providers vejam a transição.
    try {
      db.prepare(`UPDATE sessions SET parent_session_id = COALESCE(parent_session_id, id) WHERE id = ?`).run(sessionId)
      const { emitSessionSwitch } = await import('./turn-context.js')
      emitSessionSwitch({ sessionId, reason: 'compression', compressedCount: toCompress.length })
    } catch {}

    // Soft-delete mensagens antigas
    try {
      const idsToDeactivate = toCompress.map(m => m.id)
      const placeholders = idsToDeactivate.map(() => '?').join(',')
      db.prepare(`UPDATE messages SET active = 0 WHERE id IN (${placeholders})`).run(...idsToDeactivate)
    } catch (_e) { /* coluna active ainda não existe */ }

    // ── B. Deep synthesis ─────────────────────────────────────────────────────
    setImmediate(async () => {
      try {
        const fullTranscript = allMsgs
          .map(m => `${m.role === 'user' ? 'Danilo' : 'Orion'}: ${m.content.slice(0, 150)}`)
          .join('\n')

        const deepPrompt = `Analise esta sessão de conversa completa e extraia APENAS os insights de alto nível mais importantes sobre o usuário Danilo: decisões estratégicas, fatos pessoais marcantes, mudanças de projeto, aprendizados chave que serão relevantes daqui a 6 meses.

ATENÇÃO: só extraia fatos que NÃO são óbvios nem capturáveis por mensagem individual.

${fullTranscript.slice(0, 4000)}

Retorne 0 a 3 fatos semânticos, um por linha:
CATEGORIA|TAGS|fato
Se nada importante, retorne: NENHUM`

        const deepResult = await execa('claude', [
          '-p', deepPrompt,
          '--model', 'claude-haiku-4-5-20251001',
          '--output-format', 'json',
          '--dangerously-skip-permissions',
        ], { timeout: 30_000 })

        const deepText = (JSON.parse(deepResult.stdout).result ?? JSON.parse(deepResult.stdout).content ?? '').trim()
        if (!deepText || deepText.toUpperCase() === 'NENHUM') return

        const validCats = ['general', 'user_pref', 'project', 'tool', 'person', 'decision']
        let deepSaved = 0
        for (const line of deepText.split('\n').slice(0, 3)) {
          const parts = line.split('|')
          if (parts.length !== 3) continue
          const [cat, tagStr, content] = parts.map(p => p.trim())
          if (!validCats.includes(cat) || content.length < 15) continue
          const tags = tagStr ? tagStr.split(',').map(t => t.trim()).filter(Boolean) : []
          saveMemory({
            content,
            type: 'semantic',
            source: `session:${sessionId}`,
            confidence: 0.72,
            tags,
            category: cat,
            sourceTool: 'deep-synthesis',
            sourceSessionId: sessionId,
          })
          deepSaved++
        }
        if (deepSaved > 0) log.info({ deepSaved, session: sessionId.slice(0, 8) }, '[compressor] deep-synthesis: fatos semânticos extraídos')
      } catch (err) {
        log.debug({ err: err.message }, '[compressor] deep-synthesis silencioso')
      }
    })

    log.info({ compressed: toCompress.length, tailProtected: lastKept.length, session: sessionId.slice(0,8) }, '[compressor] sessão comprimida')
    return summary
  } catch (err) {
    log.error({ err: err.message }, '[compressor] erro ao comprimir')
    return session?.context_summary ?? null
  }
}
