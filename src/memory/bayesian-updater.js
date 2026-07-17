/**
 * Bayesian Confidence Updater — ajusta confiança de memórias via observações.
 *
 * Priors por fonte de observação:
 *   user_confirmed      +0.20  (usuário confirmou explicitamente)
 *   correction_learning +0.15  (veio de correção do usuário)
 *   cross_session       +0.10  (mencionado em múltiplas sessões)
 *   official_source     +0.08  (doc, resposta de API, código)
 *   haiku_extraction    +0.04  (extraído por Haiku da conversa)
 *   background_review   +0.03  (background reviewer detectou)
 *   pre_compress        +0.02  (extraído na pré-compressão)
 *   user_unhelpful      -0.15  (feedback negativo)
 *   contradiction       -0.12  (contradiz memória de alta confiança)
 *   stale_signal        -0.05  (detectado como potencialmente obsoleto)
 */

import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('bayesian')

const DELTAS = {
  user_confirmed:      +0.20,
  correction_learning: +0.15,
  cross_session:       +0.10,
  official_source:     +0.08,
  haiku_extraction:    +0.04,
  background_review:   +0.03,
  pre_compress:        +0.02,
  user_unhelpful:      -0.15,
  contradiction:       -0.12,
  stale_signal:        -0.05,
}

export function applyObservation(memoryId, observation, opts = {}) {
  const delta = DELTAS[observation]
  if (delta === undefined) return null

  const db = getDb()
  const mem = db.prepare('SELECT id, confidence, metadata FROM memories WHERE id = ?').get(memoryId)
  if (!mem) return null

  const prior = mem.confidence ?? 0.1
  const posterior = Math.max(0.01, Math.min(0.99, prior + delta))

  let meta = {}
  try { meta = JSON.parse(mem.metadata ?? '{}') } catch {}

  const bayesHistory = meta.bayes_history ?? []
  bayesHistory.push({
    obs:       observation,
    delta,
    prior:     Math.round(prior * 1000) / 1000,
    posterior: Math.round(posterior * 1000) / 1000,
    at:        Math.floor(Date.now() / 1000),
    reason:    opts.reason ?? null,
  })
  if (bayesHistory.length > 10) bayesHistory.splice(0, bayesHistory.length - 10)

  meta.bayes_history = bayesHistory
  meta.last_bayes_obs = observation

  db.prepare(`UPDATE memories SET confidence = ?, metadata = ?, updated_at = unixepoch() WHERE id = ?`).run(posterior, JSON.stringify(meta), memoryId)

  log.debug({ memoryId, observation, prior, posterior }, '[bayesian] observação aplicada')
  return { prior, posterior, delta, observation }
}

export async function applyCrossSessionBonus(content) {
  try {
    const db = getDb()
    const similar = db.prepare(`
      SELECT id, source_session_id FROM memories
      WHERE archived = 0 AND content LIKE ? AND source_session_id IS NOT NULL
      LIMIT 5
    `).all(`%${content.slice(0, 30).replace(/[%_]/g, '')}%`)
    const sessions = new Set(similar.map(m => m.source_session_id).filter(Boolean))
    if (sessions.size >= 2) {
      for (const m of similar) {
        applyObservation(m.id, 'cross_session', { reason: `mencionado em ${sessions.size} sessões` })
      }
    }
  } catch (_e) {}
}

export function getBayesHistory(memoryId) {
  const db = getDb()
  const mem = db.prepare('SELECT metadata FROM memories WHERE id = ?').get(memoryId)
  if (!mem) return []
  try { return JSON.parse(mem.metadata ?? '{}').bayes_history ?? [] } catch { return [] }
}
