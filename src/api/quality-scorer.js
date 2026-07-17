/**
 * Memory Quality Scorer — métricas de qualidade do sistema de memória.
 * quality_score (0-100) = avg_confidence * 50 + helpful_ratio * 30 + vec_coverage * 20
 * SNR por categoria: sqrt(384 / n_items) — degrada quando n_items > 96
 */

import { getDb } from '../db/index.js'
import { snrEstimate } from '../memory/hrr-composer.js'
import { getWilsonCIByCategory, wilsonCI } from '../memory/trust-calibrator.js'

export function getMemoryQualityMetrics() {
  const db = getDb()

  const avgConf = db.prepare(
    `SELECT AVG(confidence) AS avg FROM memories WHERE archived = 0`
  ).get()?.avg ?? 0

  const helpfulRow = db.prepare(
    `SELECT
      (SUM(CASE WHEN helpful_votes > 0 THEN 1.0 ELSE 0 END) / MAX(COUNT(*), 1)) AS ratio
     FROM memories WHERE archived = 0`
  ).get()
  const helpfulRatio = helpfulRow?.ratio ?? 0

  const ageDaysAvg = db.prepare(
    `SELECT AVG((unixepoch() - created_at) / 86400.0) AS avg FROM memories WHERE archived = 0`
  ).get()?.avg ?? 0

  const contradictionCount = db.prepare(
    `SELECT COUNT(*) AS n FROM memories
     WHERE archived = 0 AND json_extract(metadata, '$.contradiction_with') IS NOT NULL`
  ).get()?.n ?? 0

  const byCategoryRows = db.prepare(
    `SELECT category, COUNT(*) AS count, AVG(confidence) AS avg_conf
     FROM memories WHERE archived = 0 GROUP BY category ORDER BY count DESC`
  ).all()

  // Cobertura vetorial
  let vecCoverage = 0
  try {
    const totalActive = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get()?.n ?? 0
    const withVec = db.prepare(
      `SELECT COUNT(*) AS n FROM memories m JOIN vec_memories v ON m.rowid = v.memory_rowid WHERE m.archived = 0`
    ).get()?.n ?? 0
    vecCoverage = totalActive > 0 ? withVec / totalActive : 0
  } catch {}

  const qualityScore = Math.min(100, Math.round(
    (avgConf * 50) + (helpfulRatio * 30) + (vecCoverage * 20)
  ))

  // SNR por categoria (HRR bank capacity monitoring)
  const snrByCategory = byCategoryRows.map(r => ({
    category: r.category,
    count: r.count,
    avg_conf: Math.round((r.avg_conf ?? 0) * 1000) / 1000,
    snr: Math.round(snrEstimate(384, r.count) * 100) / 100,
    snr_ok: snrEstimate(384, r.count) >= 2.0,
  }))

  // Wilson CI global (todos os votos agregados)
  const globalVotesRow = db.prepare(`
    SELECT SUM(helpful_votes) AS hv, SUM(unhelpful_votes) AS uv
    FROM memories WHERE archived = 0
  `).get()
  const globalWilson = wilsonCI(globalVotesRow?.hv ?? 0, (globalVotesRow?.hv ?? 0) + (globalVotesRow?.uv ?? 0))

  // Wilson CI por categoria (confiabilidade por domínio)
  const wilsonByCategory = getWilsonCIByCategory()

  return {
    quality_score: qualityScore,
    avg_confidence: Math.round(avgConf * 1000) / 1000,
    helpful_ratio: Math.round(helpfulRatio * 1000) / 1000,
    vec_coverage: Math.round(vecCoverage * 1000) / 1000,
    age_days_avg: Math.round(ageDaysAvg * 10) / 10,
    contradiction_count: contradictionCount,
    wilson_ci: globalWilson,                 // IC Wilson global
    wilson_by_category: wilsonByCategory,    // IC por categoria
    by_category: snrByCategory,
  }
}
