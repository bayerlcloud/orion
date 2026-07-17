/**
 * Semantic Drift Detector — detecta quando o significado de um fato
 * derivou significativamente entre sessões.
 *
 * Mecanismo:
 * 1. Ao salvar uma memória atualizada (UPDATE), registra embedding anterior
 * 2. Compara vetores: distância coseno entre versão anterior e nova
 * 3. Se distância > DRIFT_THRESHOLD, registra no drift_log e emite alert
 *
 * Use cases:
 *   - "projeto X" evoluiu de MVP para produto SaaS → drift detectado
 *   - preferência que mudou entre sessões
 *   - decisão técnica revertida
 */

import { getDb } from '../db/index.js'
import { generateEmbedding } from './embeddings.js'
import { createLogger } from '../logger.js'
const log = createLogger('drift')

const DRIFT_THRESHOLD = 0.35  // distância coseno acima disso = drift significativo

function cosineDist(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? 1 - dot / denom : 1
}

/**
 * Verifica se um conteúdo derivou em relação ao embedding armazenado.
 * @param {string} memoryId
 * @param {string} newContent
 * @returns {Promise<{drifted: boolean, distance: number, oldContent: string|null}>}
 */
export async function checkDrift(memoryId, newContent) {
  try {
    const db = getDb()
    const mem = db.prepare('SELECT content, rowid FROM memories WHERE id = ?').get(memoryId)
    if (!mem) return { drifted: false, distance: 0, oldContent: null }

    if (mem.content === newContent) return { drifted: false, distance: 0, oldContent: mem.content }

    // Embeddings dos dois conteúdos
    const [oldEmb, newEmb] = await Promise.all([
      generateEmbedding(mem.content),
      generateEmbedding(newContent),
    ])

    if (!oldEmb || !newEmb) return { drifted: false, distance: 0, oldContent: mem.content }

    const distance = cosineDist(oldEmb, newEmb)
    const drifted = distance > DRIFT_THRESHOLD

    if (drifted) {
      // Registra no drift_log
      try {
        db.prepare(`
          INSERT INTO drift_log (memory_id, old_content, new_content, distance, detected_at)
          VALUES (?, ?, ?, ?, unixepoch())
        `).run(memoryId, mem.content, newContent, Math.round(distance * 1000) / 1000)
      } catch {}
      log.info({ memoryId, distance: Math.round(distance * 100) / 100 }, '[drift] drift semântico detectado')
    }

    return { drifted, distance, oldContent: mem.content }
  } catch (_e) {
    return { drifted: false, distance: 0, oldContent: null }
  }
}

/**
 * Lista os drifts mais recentes.
 */
export function getRecentDrifts(limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT d.*, m.category, m.confidence
      FROM drift_log d
      LEFT JOIN memories m ON m.id = d.memory_id
      ORDER BY d.detected_at DESC
      LIMIT ?
    `).all(limit)
  } catch { return [] }
}

/**
 * Sumariza um alerta de drift para humano.
 */
export function formatDriftAlert(drift) {
  const dist = (drift.distance * 100).toFixed(0)
  return `⚡ Drift ${dist}%: "${drift.old_content?.slice(0, 50)}" → "${drift.new_content?.slice(0, 50)}"`
}
