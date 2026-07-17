/**
 * Contradiction Resolver — resolução ATIVA de contradições.
 *
 * Quando detecta contradição entre A e B, enfileira pergunta ao usuário.
 * A pergunta é injetada no próximo turno. Ao responder, persiste a versão
 * correta com conf=0.95 e arquiva a incorreta.
 */

import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('contr-resolver')

export function queueForResolution(pairs) {
  if (!pairs || pairs.length === 0) return 0
  const db = getDb()
  let queued = 0

  for (const { a, b, score } of pairs) {
    try {
      const existing = db.prepare(`
        SELECT id FROM contradiction_queue
        WHERE (memory_id_a = ? AND memory_id_b = ?) OR (memory_id_a = ? AND memory_id_b = ?)
          AND resolved = 0
      `).get(a, b, b, a)
      if (existing) continue
    } catch {}

    let memA, memB
    try {
      memA = db.prepare('SELECT content FROM memories WHERE id = ?').get(a)
      memB = db.prepare('SELECT content FROM memories WHERE id = ?').get(b)
    } catch {}
    if (!memA || !memB) continue

    const question = `⚠️ *Contradição detectada* — qual é o correto?\n(A) ${memA.content.slice(0, 100)}\n(B) ${memB.content.slice(0, 100)}\n\nResponda: A, B, ou corrija manualmente`

    try {
      db.prepare(`
        INSERT INTO contradiction_queue (memory_id_a, memory_id_b, content_a, content_b, question, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      `).run(a, b, memA.content, memB.content, question, score)
      queued++
    } catch {}
  }

  if (queued > 0) log.info({ queued }, '[resolver] contradições enfileiradas')
  return queued
}

export function getNextResolutionQuestion() {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT id, question, memory_id_a, memory_id_b, content_a, content_b
      FROM contradiction_queue WHERE resolved = 0
      ORDER BY score DESC, created_at ASC LIMIT 1
    `).get()
  } catch { return null }
}

export function resolveContradiction(queueId, resolution, correctedContent = null) {
  const db = getDb()
  try {
    const q = db.prepare('SELECT * FROM contradiction_queue WHERE id = ?').get(queueId)
    if (!q) return false
    const now = Math.floor(Date.now() / 1000)
    if (resolution === 'a' || resolution === 'b') {
      const keepId = resolution === 'a' ? q.memory_id_a : q.memory_id_b
      const archiveId = resolution === 'a' ? q.memory_id_b : q.memory_id_a
      db.prepare(`UPDATE memories SET confidence=MIN(0.95, confidence+0.15), updated_at=? WHERE id=?`).run(now, keepId)
      db.prepare(`UPDATE memories SET archived=1, confidence=0.05, updated_at=? WHERE id=?`).run(now, archiveId)
      log.info({ keepId, archiveId }, '[resolver] contradição resolvida')
    } else if (resolution === 'both_wrong' && correctedContent) {
      db.prepare('UPDATE memories SET archived=1, updated_at=? WHERE id IN (?, ?)').run(now, q.memory_id_a, q.memory_id_b)
    }
    db.prepare(`UPDATE contradiction_queue SET resolved=1, resolved_at=?, resolution=? WHERE id=?`).run(now, resolution, queueId)
    return true
  } catch (err) {
    log.warn({ err: err.message }, '[resolver] erro ao resolver')
    return false
  }
}

export function listPendingContradictions(limit = 10) {
  const db = getDb()
  try { return db.prepare(`SELECT * FROM contradiction_queue WHERE resolved=0 ORDER BY score DESC LIMIT ?`).all(limit) } catch { return [] }
}

export function getResolutionStats() {
  const db = getDb()
  try {
    return {
      pending:  db.prepare('SELECT COUNT(*) AS n FROM contradiction_queue WHERE resolved=0').get()?.n ?? 0,
      resolved: db.prepare('SELECT COUNT(*) AS n FROM contradiction_queue WHERE resolved=1').get()?.n ?? 0,
    }
  } catch { return { pending: 0, resolved: 0 } }
}
