/**
 * Temporal Index — extrai e indexa eventos temporais de memórias.
 *
 * Extrai timestamps e relações de ordem (antes/depois/durante) de textos.
 * Permite queries como "o que aconteceu antes do lançamento do V2?"
 *
 * Suporte a:
 *   - Datas absolutas: "em março de 2025", "no dia 15/04"
 *   - Relativas: "semana passada", "ontem", "mês passado"
 *   - Sequências: "depois que", "antes de", "quando"
 *   - Durações: "durante 3 meses", "por 2 semanas"
 */

import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('temporal')

// Padrões de extração de datas (pt-BR)
const DATE_PATTERNS = [
  // Data completa: 15/04/2025 ou 15-04-2025
  { re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g, type: 'absolute', format: 'dmy' },
  // Mês e ano: "em março de 2025", "em março/2025"
  { re: /\bem?\s+(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de)?\s+(\d{4})\b/gi, type: 'month_year' },
  // Relativas
  { re: /\b(ontem|hoje|amanhã|anteontem)\b/gi, type: 'relative', precision: 'day' },
  { re: /\b(semana\s+passada|semana\s+que\s+vem|essa\s+semana)\b/gi, type: 'relative', precision: 'week' },
  { re: /\b(mês\s+passado|esse\s+mês|próximo\s+mês)\b/gi, type: 'relative', precision: 'month' },
  { re: /\b(ano\s+passado|esse\s+ano|próximo\s+ano)\b/gi, type: 'relative', precision: 'year' },
]

// Conectivos temporais (captura sequência de eventos)
const TEMPORAL_CONNECTIVES = [
  { re: /\bantes\s+de\b/gi, relation: 'before' },
  { re: /\bdepois\s+(?:de|que)\b/gi, relation: 'after' },
  { re: /\bdurante\b/gi, relation: 'during' },
  { re: /\bquando\b/gi, relation: 'concurrent' },
  { re: /\blogo\s+após\b/gi, relation: 'immediately_after' },
  { re: /\bao\s+mesmo\s+tempo\b/gi, relation: 'concurrent' },
]

const MONTH_MAP = {
  janeiro: 1, fevereiro: 2, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
}

function resolveRelativeDate(token, referenceEpoch = null) {
  const now = referenceEpoch ?? Math.floor(Date.now() / 1000)
  const t = token.toLowerCase()
  if (t === 'ontem' || t === 'yesterday') return now - 86400
  if (t === 'hoje' || t === 'today') return now
  if (t === 'amanhã') return now + 86400
  if (t.includes('semana passada')) return now - 7 * 86400
  if (t.includes('mês passado')) return now - 30 * 86400
  if (t.includes('ano passado')) return now - 365 * 86400
  return null
}

/**
 * Extrai eventos temporais de um texto.
 * @returns {Array<{type, text, epoch, precision, connective}>}
 */
export function extractTemporalEvents(text, referenceEpoch = null) {
  const events = []
  const ref = referenceEpoch ?? Math.floor(Date.now() / 1000)

  // Datas absolutas dia/mês/ano
  const absRe = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g
  let m
  while ((m = absRe.exec(text)) !== null) {
    const [, d, mo, y] = m
    const epoch = Math.floor(new Date(`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`).getTime() / 1000)
    if (!isNaN(epoch)) events.push({ type: 'absolute', text: m[0], epoch, precision: 'day' })
  }

  // Mês + ano
  const myRe = /\bem?\s+(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de)?\s+(\d{4})\b/gi
  while ((m = myRe.exec(text)) !== null) {
    const month = MONTH_MAP[m[1].toLowerCase()]
    const year = parseInt(m[2])
    if (month && year) {
      const epoch = Math.floor(new Date(year, month - 1, 1).getTime() / 1000)
      events.push({ type: 'month_year', text: m[0], epoch, precision: 'month' })
    }
  }

  // Datas relativas
  const relRe = /\b(ontem|hoje|amanhã|anteontem|semana\s+passada|semana\s+que\s+vem|mês\s+passado|esse\s+mês|ano\s+passado|esse\s+ano)\b/gi
  while ((m = relRe.exec(text)) !== null) {
    const epoch = resolveRelativeDate(m[0], ref)
    if (epoch) events.push({ type: 'relative', text: m[0], epoch, precision: 'day' })
  }

  // Conectivos temporais
  for (const { re, relation } of TEMPORAL_CONNECTIVES) {
    re.lastIndex = 0
    if (re.test(text)) {
      events.push({ type: 'connective', relation, text: text.slice(0, 100) })
    }
  }

  return events
}

/**
 * Indexa eventos temporais de uma memória no banco.
 */
export function indexMemoryEvents(memoryId, content, createdAt) {
  const events = extractTemporalEvents(content, createdAt)
  if (events.length === 0) return 0

  const db = getDb()
  let saved = 0
  for (const ev of events) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO temporal_events
          (memory_id, event_type, event_text, epoch, precision, relation)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        memoryId,
        ev.type,
        ev.text ?? null,
        ev.epoch ?? null,
        ev.precision ?? null,
        ev.relation ?? null,
      )
      saved++
    } catch {}
  }
  return saved
}

/**
 * Recupera memórias dentro de um intervalo de tempo.
 * @param {number} fromEpoch - início do período
 * @param {number} toEpoch - fim do período
 * @param {number} limit
 */
export function getMemoriesInPeriod(fromEpoch, toEpoch, limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT DISTINCT m.id, m.content, m.category, m.confidence, te.epoch
      FROM temporal_events te
      JOIN memories m ON m.id = te.memory_id
      WHERE te.epoch BETWEEN ? AND ?
        AND m.archived = 0
      ORDER BY te.epoch DESC
      LIMIT ?
    `).all(fromEpoch, toEpoch, limit)
  } catch { return [] }
}

/**
 * Ordena memórias cronologicamente usando eventos indexados.
 */
export function getChronologicalMemories(memoryIds) {
  if (memoryIds.length === 0) return []
  const db = getDb()
  const placeholders = memoryIds.map(() => '?').join(',')
  try {
    return db.prepare(`
      SELECT m.*, MIN(te.epoch) AS earliest_event
      FROM memories m
      LEFT JOIN temporal_events te ON te.memory_id = m.id
      WHERE m.id IN (${placeholders})
      GROUP BY m.id
      ORDER BY earliest_event ASC, m.created_at ASC
    `).all(...memoryIds)
  } catch {
    return memoryIds.map(id => ({ id }))
  }
}

/** Stats do índice temporal. */
export function getTemporalIndexStats() {
  const db = getDb()
  try {
    return {
      total: db.prepare('SELECT COUNT(*) AS n FROM temporal_events').get()?.n ?? 0,
      byType: db.prepare('SELECT event_type, COUNT(*) AS n FROM temporal_events GROUP BY event_type').all(),
    }
  } catch { return { total: 0, byType: [] } }
}
