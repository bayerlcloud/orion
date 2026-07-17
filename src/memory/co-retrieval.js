/**
 * Co-retrieval Graph — memória associativa.
 *
 * Quando memórias A e B são recuperadas no mesmo turno, incrementa
 * co_retrievals(id_a, id_b, count). Com o tempo, cria links associativos.
 */

import { getDb } from '../db/index.js'

const CO_BONUS_MAX = 0.06
const CO_MIN_COUNT = 3
const MAX_EXTRAS   = 2

export function recordCoRetrieval(ids) {
  if (!ids || ids.length < 2) return
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  try {
    const stmt = db.prepare(`
      INSERT INTO co_retrievals (id_a, id_b, count, last_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(id_a, id_b) DO UPDATE SET count=count+1, last_at=?
    `)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]
        stmt.run(a, b, now, now)
      }
    }
  } catch {}
}

export function getCoRetrievalBonus(id, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return 0
  const db = getDb()
  try {
    let total = 0
    for (const sel of selectedIds) {
      const [a, b] = id < sel ? [id, sel] : [sel, id]
      const row = db.prepare(`SELECT count FROM co_retrievals WHERE id_a=? AND id_b=?`).get(a, b)
      if (row && row.count >= CO_MIN_COUNT) total += row.count
    }
    return Math.min(CO_BONUS_MAX, (total / (selectedIds.length * 10)) * CO_BONUS_MAX)
  } catch { return 0 }
}

export function getSuggestedAssociates(selectedIds, excludeIds = []) {
  if (!selectedIds || selectedIds.length === 0) return []
  const db = getDb()
  const allExclude = new Set([...selectedIds, ...excludeIds])
  try {
    const ph = selectedIds.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT
        CASE WHEN id_a IN (${ph}) THEN id_b ELSE id_a END AS associate_id,
        SUM(count) AS total_count
      FROM co_retrievals
      WHERE (id_a IN (${ph}) OR id_b IN (${ph}))
      GROUP BY associate_id HAVING total_count >= ?
      ORDER BY total_count DESC LIMIT ?
    `).all(...selectedIds, ...selectedIds, ...selectedIds, CO_MIN_COUNT, MAX_EXTRAS + allExclude.size)
    return rows.filter(r => !allExclude.has(r.associate_id)).slice(0, MAX_EXTRAS).map(r => r.associate_id)
  } catch { return [] }
}
