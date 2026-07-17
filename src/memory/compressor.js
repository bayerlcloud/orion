/**
 * Context Compressor — comprime sessões longas para economizar contexto.
 *
 * - Token-aware: protege janelas por tokens (não message-count)
 * - Tool output pruning antes do LLM resumir
 * - Seções estruturadas no sumário
 * - Extrai fatos ANTES de descartar (on_pre_compress)
 * - Deep synthesis pós-compressão (extraia insights de alto nível)
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { saveMemory } from './index.js'
import { createLogger } from '../logger.js'
const log = createLogger('compressor')

const COMPRESS_AFTER       = 40
const KEEP_FIRST           = 5
const KEEP_LAST_TOKENS_EST = 3000
const TOKEN_TRIGGER_RATIO  = 0.72
const MODEL_CONTEXT = { 'claude-sonnet-4-6': 200_000, 'claude-haiku-4-5-20251001': 200_000, default: 200_000 }

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
const COMPRESSED_SUMMARY_METADATA_KEY = '_compressed_summary'

function estimateTokens(text) { return Math.ceil((text?.length ?? 0) / 4) }
function msgTokens(msg) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
  return estimateTokens(content)
}
function pruneToolOutputs(messages, maxToolOutputTokens = 500) {
  return messages.map(m => {
    if (!m.content || typeof m.content !== 'string') return m
    if (estimateTokens(m.content) > maxToolOutputTokens && m.role === 'assistant') {
      return { ...m, content: m.content.slice(0, maxToolOutputTokens * 4) + '\n[... output truncado ...]' }
    }
    return m
  })
}

export async function compressSessionIfNeeded(sessionId, opts = {}) {
  const db = getDb()
  const { model = 'claude-haiku-4-5-20251001', usageTokens = null } = opts

  let n = 0
  try { n = db.prepare('SELECT COUNT(*) as n FROM messages WHERE session_id=? AND active=1').get(sessionId)?.n ?? 0 } catch (_e) { n = db.prepare('SELECT COUNT(*) as n FROM messages WHERE session_id=?').get(sessionId)?.n ?? 0 }

  let shouldCompress = n >= COMPRESS_AFTER
  if (usageTokens != null) {
    const ratio = usageTokens / (MODEL_CONTEXT[model] ?? MODEL_CONTEXT.default)
    if (ratio > TOKEN_TRIGGER_RATIO) shouldCompress = true
  }
  if (!shouldCompress) return null

  let session = null
  try { session = db.prepare('SELECT context_summary FROM sessions WHERE id=?').get(sessionId) } catch {}
  if (session?.context_summary && n < COMPRESS_AFTER + 10) return session.context_summary

  let allMsgs = []
  try { allMsgs = db.prepare(`SELECT id, role, content FROM messages WHERE session_id=? AND active=1 ORDER BY created_at ASC`).all(sessionId) } catch (_e) { allMsgs = db.prepare(`SELECT id, role, content FROM messages WHERE session_id=? ORDER BY created_at ASC`).all(sessionId) }

  const firstKept = allMsgs.slice(0, KEEP_FIRST)
  const firstIds  = new Set(firstKept.map(m => m.id))
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

  const prunedMsgs = pruneToolOutputs(toCompress)
  const transcript = prunedMsgs.map(m => `${m.role === 'user' ? 'Usuário' : 'Orion'}: ${m.content.slice(0, 500)}`).join('\n\n')

  // on_pre_compress: extrai fatos antes de descartar
  setImmediate(async () => {
    try {
      const r = await execa('claude', ['-p',
        `Extraia 0 a 5 fatos concretos sobre o usuário desta conversa. Formato: CATEGORIA|TAGS|fato\nCATEGORIA: general,user_pref,project,tool,person,decision\n\n${transcript.slice(0, 3000)}\n\nSe não houver, retorne: NENHUM`,
        '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'
      ], { timeout: 45_000 })
      const text = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
      if (!text || text.toUpperCase() === 'NENHUM') return
      const validCats = ['general','user_pref','project','tool','person','decision']
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
      if (saved > 0) log.info({ saved }, '[compressor] on_pre_compress')
    } catch (err) { log.debug({ err: err.message }, '[compressor] on_pre_compress silencioso') }
  })

  const prev = session?.context_summary ? `\n\nRESUMO ANTERIOR (mesclar/atualizar):\n${session.context_summary}` : ''
  const prompt = `Crie um resumo estruturado em português desta conversa nas seções:\n## Tarefas Pendentes\n## Próximos Passos\n## Decisões Tomadas\n## Tarefas Realizadas\n## Pedidos Pendentes do Usuário\n## Contexto Essencial${prev}\n\n---\nTRANSCRIPT:\n${transcript}\n\nPreencha apenas seções com conteúdo relevante:`

  try {
    const result = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'], { timeout: 60_000 })
    const parsed = JSON.parse(result.stdout)
    const rawSummary = parsed.result ?? parsed.content ?? ''
    const summary = `${COMPACTION_PREAMBLE}\n\n[${COMPRESSED_SUMMARY_METADATA_KEY}]\n${rawSummary.trim()}\n\n${COMPACTION_END_MARKER}`
    if (!summary) return session?.context_summary ?? null

    try { db.prepare('UPDATE sessions SET context_summary=? WHERE id=?').run(summary, sessionId) } catch {}
    try {
      db.prepare(`UPDATE sessions SET parent_session_id=COALESCE(parent_session_id, id) WHERE id=?`).run(sessionId)
      const { emitSessionSwitch } = await import('./turn-context.js')
      emitSessionSwitch({ sessionId, reason: 'compression', compressedCount: toCompress.length })
    } catch {}

    try {
      const placeholders = toCompress.map(() => '?').join(',')
      db.prepare(`UPDATE messages SET active=0 WHERE id IN (${placeholders})`).run(...toCompress.map(m => m.id))
    } catch {}

    log.info({ compressed: toCompress.length, session: sessionId.slice(0,8) }, '[compressor] sessão comprimida')
    return summary
  } catch (err) {
    log.error({ err: err.message }, '[compressor] erro ao comprimir')
    return session?.context_summary ?? null
  }
}
