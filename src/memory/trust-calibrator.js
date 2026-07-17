/**
 * Trust Calibrator — verifica se confidence prevista ≈ acurácia real.
 *
 * Para cada bucket de confidence (0.0-0.1, 0.1-0.2, ..., 0.9-1.0):
 *   actual_accuracy = helpful_votes / (helpful_votes + unhelpful_votes)
 *   calibration_factor = actual_accuracy / predicted_avg_confidence
 */

import { getDb } from '../db/index.js'

const BUCKET_SIZE = 0.1
const MIN_SAMPLES = 3

export function computeCalibration() {
  const db = getDb()
  const buckets = []

  for (let low = 0; low < 1.0; low = Math.round((low + BUCKET_SIZE) * 10) / 10) {
    const high = Math.min(1.0, Math.round((low + BUCKET_SIZE) * 10) / 10)
    const row = db.prepare(`
      SELECT AVG(confidence) AS avg_conf,
             SUM(helpful_votes) AS helpful, SUM(unhelpful_votes) AS unhelpful,
             COUNT(*) AS n
      FROM memories WHERE confidence>=? AND confidence<? AND archived=0
        AND (helpful_votes>0 OR unhelpful_votes>0)
    `).get(low, high)
    if (!row || row.n < MIN_SAMPLES) continue
    const totalVotes = (row.helpful ?? 0) + (row.unhelpful ?? 0)
    if (totalVotes === 0) continue
    const actualAccuracy = row.helpful / totalVotes
    const predictedAvg   = row.avg_conf ?? ((low + high) / 2)
    const calibFactor    = actualAccuracy / (predictedAvg + 1e-6)
    buckets.push({
      range:              `${low.toFixed(1)}-${high.toFixed(1)}`,
      predicted_avg:      Math.round(predictedAvg * 1000) / 1000,
      actual_accuracy:    Math.round(actualAccuracy * 1000) / 1000,
      calibration_factor: Math.round(calibFactor * 1000) / 1000,
      sample_count:       row.n,
    })
  }

  if (buckets.length > 0) {
    const stmt = db.prepare(`INSERT INTO trust_calibration (confidence_low, confidence_hi, predicted_avg, actual_accuracy, sample_count) VALUES (?, ?, ?, ?, ?)`)
    for (const b of buckets) {
      const [lo, hi] = b.range.split('-').map(Number)
      try { stmt.run(lo, hi, b.predicted_avg, b.actual_accuracy, b.sample_count) } catch {}
    }
  }

  return buckets
}

export function getGlobalCalibrationFactor() {
  const db = getDb()
  const row = db.prepare(`
    SELECT AVG(actual_accuracy / (predicted_avg + 0.001)) AS factor
    FROM trust_calibration WHERE computed_at > (unixepoch() - 90 * 86400)
  `).get()
  return row?.factor ?? 1.0
}

export function wilsonCI(successes, total, z = 1.96) {
  if (total === 0) return { center: 0, low: 0, high: 0, width: 0, n: 0 }
  const z2 = z * z
  const center = (successes + z2 / 2) / (total + z2)
  const spread = z * Math.sqrt(center * (1 - center) / (total + z2))
  return {
    center: Math.round(center * 1000) / 1000,
    low:    Math.round(Math.max(0, center - spread) * 1000) / 1000,
    high:   Math.round(Math.min(1, center + spread) * 1000) / 1000,
    width:  Math.round(spread * 2 * 1000) / 1000,
    n:      total,
  }
}

export function getWilsonCIByCategory() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT category, SUM(helpful_votes) AS helpful, SUM(unhelpful_votes) AS unhelpful
    FROM memories WHERE archived=0 AND (helpful_votes>0 OR unhelpful_votes>0)
    GROUP BY category
  `).all()
  return rows.map(r => ({ category: r.category, ...wilsonCI(r.helpful ?? 0, (r.helpful ?? 0) + (r.unhelpful ?? 0)) }))
}
