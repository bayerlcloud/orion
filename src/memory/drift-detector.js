/**
 * Semantic Drift Detector — detecta quando o significado de um fato
 * derivou significativamente entre sessões.
 *
 * Compara vetores coseno entre versão anterior e nova.
 * Se distância > DRIFT_THRESHOLD, registra no drift_log.
 */

import { getDb } from '../db/index.js'
import { generateEmbedding } from './embeddings.js'
import { createLogger } from '../logger.js'
const log = createLogger('drift')

const DRIFT_THRESHOLD = 0.35

function cosineDist(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? 1 - dot / denom : 1
}

export async function checkDrift(memoryId, newContent) {
  try {
    const db = getDb()
    const mem = db.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId)
    if (!mem) return { drifted: false, distance: 0, oldContent: null }
    if (mem.content === newContent) return { drifted: false, distance: 0, oldContent: mem.content }

    const [oldEmb, newEmb] = await Promise.all([
      generateEmbedding(mem.content),
      generateEmbedding(newContent),
    ])
    if (!oldEmb || !newEmb) return { drifted: false, distance: 0, oldContent: mem.content }

    const distance = cosineDist(oldEmb, newEmb)
    const drifted = distance > DRIFT_THRESHOLD

    if (drifted) {
      try {
        db.prepare(`INSERT INTO drift_log (memory_id, old_content, new_content, distance, detected_at) VALUES (?, ?, ?, ?, unixepoch())`).run(memoryId, mem.content, newContent, Math.round(distance * 1000) / 1000)
      } catch {}
      log.info({ memoryId, distance: Math.round(distance * 100) / 100 }, '[drift] drift semântico detectado')
    }

    return { drifted, distance, oldContent: mem.content }
  } catch (_e) {
    return { drifted: false, distance: 0, oldContent: null }
  }
}

export function getRecentDrifts(limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT d.*, m.category, m.confidence FROM drift_log d
      LEFT JOIN memories m ON m.id = d.memory_id
      ORDER BY d.detected_at DESC LIMIT ?
    `).all(limit)
  } catch { return [] }
}

export function formatDriftAlert(drift) {
  const dist = (drift.distance * 100).toFixed(0)
  return `⚡ Drift ${dist}%: "${drift.old_content?.slice(0, 50)}" → "${drift.new_content?.slice(0, 50)}"`
}
