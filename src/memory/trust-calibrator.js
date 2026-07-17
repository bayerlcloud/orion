/**
 * Trust Calibrator — verifica se confidence prevista ≈ acurácia real.
 *
 * Para cada bucket de confidence (0.0-0.1, 0.1-0.2, ..., 0.9-1.0):
 *   actual_accuracy = helpful_votes / (helpful_votes + unhelpful_votes)
 *   calibration_factor = actual_accuracy / predicted_avg_confidence
 *
 * calibration_factor > 1: agente é conservador (subestima)
 * calibration_factor < 1: agente é otimista demais (superestima)
 *
 * Os resultados são salvos em trust_calibration para monitoramento.
 */

import { getDb } from '../db/index.js'

const BUCKET_SIZE = 0.1
const MIN_SAMPLES = 3  // mínimo para calcular bucket confiável

export function computeCalibration() {
  const db = getDb()
  const buckets = []

  for (let low = 0; low < 1.0; low = Math.round((low + BUCKET_SIZE) * 10) / 10) {
    const high = Math.min(1.0, Math.round((low + BUCKET_SIZE) * 10) / 10)

    const row = db.prepare(`
      SELECT
        AVG(confidence) AS avg_conf,
        SUM(helpful_votes)   AS helpful,
        SUM(unhelpful_votes) AS unhelpful,
        COUNT(*) AS n
      FROM memories
      WHERE confidence >= ? AND confidence < ?
        AND archived = 0
        AND (helpful_votes > 0 OR unhelpful_votes > 0)
    `).get(low, high)

    if (!row || row.n < MIN_SAMPLES) continue

    const totalVotes = (row.helpful ?? 0) + (row.unhelpful ?? 0)
    if (totalVotes === 0) continue

    const actualAccuracy  = row.helpful / totalVotes
    const predictedAvg    = row.avg_conf ?? ((low + high) / 2)
    const calibFactor     = actualAccuracy / (predictedAvg + 1e-6)

    buckets.push({
      range:              `${low.toFixed(1)}-${high.toFixed(1)}`,
      predicted_avg:      Math.round(predictedAvg * 1000) / 1000,
      actual_accuracy:    Math.round(actualAccuracy * 1000) / 1000,
      calibration_factor: Math.round(calibFactor * 1000) / 1000,
      sample_count:       row.n,
    })
  }

  // Persiste no banco
  if (buckets.length > 0) {
    const now = Math.floor(Date.now() / 1000)
    const stmt = db.prepare(`
      INSERT INTO trust_calibration (confidence_low, confidence_hi, predicted_avg, actual_accuracy, sample_count)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const b of buckets) {
      const [lo, hi] = b.range.split('-').map(Number)
      try { stmt.run(lo, hi, b.predicted_avg, b.actual_accuracy, b.sample_count) } catch {}
    }
  }

  return buckets
}

/**
 * Retorna o fator de calibração global médio.
 * Uso: confidence_corrigida = raw_conf × getGlobalCalibrationFactor()
 */
export function getGlobalCalibrationFactor() {
  const db = getDb()

  const row = db.prepare(`
    SELECT AVG(actual_accuracy / (predicted_avg + 0.001)) AS factor
    FROM trust_calibration
    WHERE computed_at > (unixepoch() - 90 * 86400)
  `).get()

  return row?.factor ?? 1.0  // neutro se não houver dados
}

/**
 * Wilson Score Interval — intervalo de confiança Bayesiano para proporções.
 * Mais robusto que CI binomial simples para n pequeno.
 *
 * Fórmula: p̂ = (successes + z²/2) / (n + z²)
 * CI: p̂ ± z × sqrt(p̂(1−p̂)/(n+z²))
 *
 * @param {number} successes - votos positivos (helpful_votes)
 * @param {number} total     - total de votos (helpful + unhelpful)
 * @param {number} z         - z-score (1.96 = 95% CI)
 * @returns {{ center, low, high, width, n }}
 */
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

/**
 * Calcula Wilson CI por categoria (sucesso = helpful_votes).
 * Retorna uma estimativa de quanto cada categoria de memória é confiável
 * com base no feedback real dos usuários.
 */
export function getWilsonCIByCategory() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT category,
           SUM(helpful_votes)   AS helpful,
           SUM(unhelpful_votes) AS unhelpful
    FROM memories
    WHERE archived = 0 AND (helpful_votes > 0 OR unhelpful_votes > 0)
    GROUP BY category
  `).all()

  return rows.map(r => ({
    category: r.category,
    ...wilsonCI(r.helpful ?? 0, (r.helpful ?? 0) + (r.unhelpful ?? 0)),
  }))
}
