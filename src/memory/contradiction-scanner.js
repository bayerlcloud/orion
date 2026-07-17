/**
 * Contradiction Scanner — varredura sistemática O(n²) por pares contraditórios.
 * Fatos com alta sobreposição de entidades + baixa similaridade de conteúdo
 * são marcados como contradições potenciais no metadata.
 *
 * contradiction_score = entity_overlap × (1 - content_jaccard)
 * Threshold: score > 0.35
 */

import { getDb } from '../db/index.js'
import { queueForResolution } from './contradiction-resolver.js'
import { emitBrain } from '../brain-events.js'

// Extrai entidades (palavras capitalizadas + nomes conhecidos)
function extractNamedEntities(text) {
  const caps = text.match(/\b[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÈÌÒÙÇ][a-záéíóúâêîôûãõàèìòùç]+\b/g) ?? []
  return new Set(caps.filter(w => w.length > 2))
}

function jaccardTokens(a, b) {
  const tokA = new Set(a.toLowerCase().split(/\W+/).filter(t => t.length > 3))
  const tokB = new Set(b.toLowerCase().split(/\W+/).filter(t => t.length > 3))
  if (tokA.size === 0 || tokB.size === 0) return 0
  let inter = 0
  for (const t of tokA) if (tokB.has(t)) inter++
  return inter / (tokA.size + tokB.size - inter)
}

function entityOverlap(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const e of setA) if (setB.has(e)) inter++
  return inter / (setA.size + setB.size - inter)
}

/**
 * Varre até `limit` memórias da categoria procurando contradições.
 * Marca pares com contradiction_score > threshold no metadata.
 * @returns {number} pares contraditórios encontrados
 */
export function scanContradictions(category = null, { limit = 150, threshold = 0.35 } = {}) {
  const db = getDb()

  const query = category
    ? `SELECT id, content, metadata FROM memories WHERE archived = 0 AND category = ? ORDER BY confidence DESC LIMIT ?`
    : `SELECT id, content, metadata FROM memories WHERE archived = 0 ORDER BY confidence DESC LIMIT ?`

  const memories = category
    ? db.prepare(query).all(category, limit)
    : db.prepare(query).all(limit)

  const pairs = []

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]
      const b = memories[j]

      const entA = extractNamedEntities(a.content)
      const entB = extractNamedEntities(b.content)
      const overlap = entityOverlap(entA, entB)

      if (overlap < 0.25) continue  // entidades diferentes → não são sobre o mesmo assunto

      const contentSim = jaccardTokens(a.content, b.content)
      const score = overlap * (1 - contentSim)

      if (score > threshold) {
        pairs.push({ a: a.id, b: b.id, score: Math.round(score * 100) / 100 })
      }
    }
  }

  // Persiste hints no metadata dos envolvidos
  const stmt = db.prepare('SELECT metadata FROM memories WHERE id = ?')
  const upd  = db.prepare('UPDATE memories SET metadata = ?, updated_at = unixepoch() WHERE id = ?')

  for (const { a, b, score } of pairs) {
    for (const [id, other] of [[a, b], [b, a]]) {
      const row = stmt.get(id)
      let meta = {}
      try { meta = JSON.parse(row?.metadata ?? '{}') } catch {}
      // Só sobrescreve se o novo score for mais alto
      if (!meta.contradiction_with || score > (meta.contradiction_score ?? 0)) {
        meta.contradiction_with  = other
        meta.contradiction_score = score
        meta.contradiction_at    = Math.floor(Date.now() / 1000)
        try { upd.run(JSON.stringify(meta), id) } catch {}
      }
    }
  }

  // Enfileira contradições para resolução ativa (Round 4, item 2)
  if (pairs.length > 0) {
    try { queueForResolution(pairs) } catch {}
    try { emitBrain('contradiction', { text: `${pairs.length} contradição(ões) detectada(s)${category ? ` em ${category}` : ''}`, count: pairs.length }) } catch {}
  }

  return pairs.length
}
