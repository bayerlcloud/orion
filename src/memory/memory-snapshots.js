/**
 * Memory Snapshots — time-travel para estado de memórias.
 *
 * Captura hash do estado de memórias no início de cada sessão.
 */

import { createHash } from 'crypto'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('snapshots')

function memoryHash(content, confidence) {
  return createHash('sha1').update(`${content}|${confidence.toFixed(3)}`).digest('hex').slice(0, 12)
}

export function createSessionSnapshot(sessionId) {
  if (!sessionId) return 0
  const db = getDb()
  try {
    const existing = db.prepare(`SELECT COUNT(*) as n FROM memory_snapshots WHERE session_id=?`).get(sessionId)
    if (existing.n > 0) return 0
  } catch { return 0 }

  const memories = db.prepare(`SELECT id, content, confidence, category, type FROM memories WHERE archived=0 LIMIT 2000`).all()
  if (memories.length === 0) return 0

  const epoch = Math.floor(Date.now() / 1000)
  const insertStmt = db.prepare(`INSERT OR IGNORE INTO memory_snapshots (session_id, snapshot_epoch, memory_id, content_hash, confidence, category, type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const insertMany = db.transaction(mems => {
    for (const m of mems) {
      try { insertStmt.run(sessionId, epoch, m.id, memoryHash(m.content, m.confidence), m.confidence, m.category ?? 'general', m.type) } catch {}
    }
  })

  try { insertMany(memories); log.debug({ sessionId, count: memories.length }, '[snapshots] snapshot criado'); return memories.length } catch (err) { log.warn({ err: err.message }, '[snapshots] erro'); return 0 }
}

export function getMemoryStateAt(memoryId, targetEpoch) {
  const db = getDb()
  try {
    const snapshot = db.prepare(`SELECT snapshot_epoch, content_hash, confidence, category FROM memory_snapshots WHERE memory_id=? AND snapshot_epoch<=? ORDER BY snapshot_epoch DESC LIMIT 1`).get(memoryId, targetEpoch)
    if (!snapshot) return null
    return { memory_id: memoryId, content_hash: snapshot.content_hash, confidence: snapshot.confidence, category: snapshot.category, as_of: snapshot.snapshot_epoch, as_of_iso: new Date(snapshot.snapshot_epoch * 1000).toISOString().slice(0, 10) }
  } catch { return null }
}

export function compareSnapshots(epochOld, epochNew) {
  const db = getDb()
  try {
    const oldSnap = db.prepare(`SELECT memory_id, content_hash, confidence FROM memory_snapshots WHERE snapshot_epoch<=? GROUP BY memory_id HAVING MAX(snapshot_epoch)`).all(epochOld)
    const newSnap = db.prepare(`SELECT memory_id, content_hash, confidence FROM memory_snapshots WHERE snapshot_epoch<=? GROUP BY memory_id HAVING MAX(snapshot_epoch)`).all(epochNew)
    const oldMap = new Map(oldSnap.map(r => [r.memory_id, r]))
    const newMap = new Map(newSnap.map(r => [r.memory_id, r]))
    const changed = [], added = [], removed = []
    for (const [id, newRow] of newMap) {
      const oldRow = oldMap.get(id)
      if (!oldRow) added.push({ memory_id: id, confidence: newRow.confidence })
      else if (oldRow.content_hash !== newRow.content_hash) changed.push({ memory_id: id, old_confidence: oldRow.confidence, new_confidence: newRow.confidence, confidence_delta: newRow.confidence - oldRow.confidence })
    }
    for (const [id] of oldMap) { if (!newMap.has(id)) removed.push({ memory_id: id }) }
    return { changed, added, removed }
  } catch { return { changed: [], added: [], removed: [] } }
}

export function listSnapshotSessions(limit = 20) {
  const db = getDb()
  try { return db.prepare(`SELECT session_id, MIN(snapshot_epoch) as epoch, COUNT(*) as memory_count FROM memory_snapshots GROUP BY session_id ORDER BY epoch DESC LIMIT ?`).all(limit) } catch { return [] }
}

export function pruneOldSnapshots(maxAgeDays = 90) {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400
  try { const r = db.prepare(`DELETE FROM memory_snapshots WHERE snapshot_epoch<?`).run(cutoff); return r.changes } catch { return 0 }
}
