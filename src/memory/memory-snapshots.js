/**
 * Memory Snapshots (U5) — time-travel para estado de memórias.
 *
 * Captura hash do estado de memórias no início de cada sessão.
 * Habilita:
 *   - "O que eu acreditava sobre X em março?"
 *   - Revisão de crença histórica
 *   - Detecção de drift por comparação direta
 */

import { createHash } from 'crypto'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('snapshots')

/** Hash simples de conteúdo + confidence para detectar mudança */
function memoryHash(content, confidence) {
  return createHash('sha1').update(`${content}|${confidence.toFixed(3)}`).digest('hex').slice(0, 12)
}

/**
 * Cria snapshot do estado atual de todas as memórias não-arquivadas.
 * Idempotente: ignora se já existe snapshot para esta sessão.
 */
export function createSessionSnapshot(sessionId) {
  if (!sessionId) return 0
  const db = getDb()

  // Verifica se já existe snapshot para esta sessão
  try {
    const existing = db.prepare(`SELECT COUNT(*) as n FROM memory_snapshots WHERE session_id = ?`).get(sessionId)
    if (existing.n > 0) return 0
  } catch { return 0 }

  const memories = db.prepare(`
    SELECT id, content, confidence, category, type, created_at
    FROM memories
    WHERE archived = 0
    LIMIT 2000
  `).all()

  if (memories.length === 0) return 0

  const epoch = Math.floor(Date.now() / 1000)
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO memory_snapshots
      (session_id, snapshot_epoch, memory_id, content_hash, confidence, category, type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction(mems => {
    for (const m of mems) {
      try {
        insertStmt.run(sessionId, epoch, m.id, memoryHash(m.content, m.confidence), m.confidence, m.category ?? 'general', m.type)
      } catch {}
    }
  })

  try {
    insertMany(memories)
    log.debug({ sessionId, count: memories.length }, '[snapshots] snapshot criado')
    return memories.length
  } catch (err) {
    log.warn({ err: err.message }, '[snapshots] erro ao criar snapshot')
    return 0
  }
}

/**
 * Busca o estado de uma memória em uma data específica.
 * @param {string} memoryId
 * @param {number} targetEpoch - unix timestamp
 */
export function getMemoryStateAt(memoryId, targetEpoch) {
  const db = getDb()
  try {
    const snapshot = db.prepare(`
      SELECT snapshot_epoch, content_hash, confidence, category
      FROM memory_snapshots
      WHERE memory_id = ? AND snapshot_epoch <= ?
      ORDER BY snapshot_epoch DESC
      LIMIT 1
    `).get(memoryId, targetEpoch)

    if (!snapshot) return null

    return {
      memory_id: memoryId,
      content_hash: snapshot.content_hash,
      confidence: snapshot.confidence,
      category: snapshot.category,
      as_of: snapshot.snapshot_epoch,
      as_of_iso: new Date(snapshot.snapshot_epoch * 1000).toISOString().slice(0, 10),
    }
  } catch { return null }
}

/**
 * Compara estado de todas as memórias entre duas datas.
 * Útil para detectar o que mudou entre sessões.
 */
export function compareSnapshots(epochOld, epochNew) {
  const db = getDb()
  try {
    const oldSnap = db.prepare(`
      SELECT memory_id, content_hash, confidence
      FROM memory_snapshots WHERE snapshot_epoch <= ?
      GROUP BY memory_id HAVING MAX(snapshot_epoch)
    `).all(epochOld)

    const newSnap = db.prepare(`
      SELECT memory_id, content_hash, confidence
      FROM memory_snapshots WHERE snapshot_epoch <= ?
      GROUP BY memory_id HAVING MAX(snapshot_epoch)
    `).all(epochNew)

    const oldMap = new Map(oldSnap.map(r => [r.memory_id, r]))
    const newMap = new Map(newSnap.map(r => [r.memory_id, r]))

    const changed = []
    const added = []
    const removed = []

    for (const [id, newRow] of newMap) {
      const oldRow = oldMap.get(id)
      if (!oldRow) {
        added.push({ memory_id: id, confidence: newRow.confidence })
      } else if (oldRow.content_hash !== newRow.content_hash) {
        changed.push({
          memory_id: id,
          old_confidence: oldRow.confidence,
          new_confidence: newRow.confidence,
          confidence_delta: newRow.confidence - oldRow.confidence,
        })
      }
    }

    for (const [id] of oldMap) {
      if (!newMap.has(id)) removed.push({ memory_id: id })
    }

    return { changed, added, removed }
  } catch { return { changed: [], added: [], removed: [] } }
}

/**
 * Lista sessões que têm snapshots (para time-travel).
 */
export function listSnapshotSessions(limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT session_id, MIN(snapshot_epoch) as epoch, COUNT(*) as memory_count
      FROM memory_snapshots
      GROUP BY session_id
      ORDER BY epoch DESC
      LIMIT ?
    `).all(limit)
  } catch { return [] }
}

/**
 * Limpa snapshots antigos (> 90 dias) para evitar crescimento infinito.
 */
export function pruneOldSnapshots(maxAgeDays = 90) {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400
  try {
    const r = db.prepare(`DELETE FROM memory_snapshots WHERE snapshot_epoch < ?`).run(cutoff)
    log.info({ deleted: r.changes }, '[snapshots] snapshots antigos removidos')
    return r.changes
  } catch { return 0 }
}
