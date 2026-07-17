/**
 * Fase 5 — Self-Audit Semanal (domingos 9h)
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { sendWhatsApp } from '../gateway/evolution.js'
import { logger } from '../logger.js'
import { scheduleNextReview } from '../memory/index.js'
import { computeCalibration } from '../memory/trust-calibrator.js'

async function callHaiku(prompt) {
  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 20_000 })
    const parsed = JSON.parse(result.stdout)
    return (parsed.result ?? parsed.content ?? '').trim()
  } catch { return null }
}

export async function runPhase5() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  let audited = 0, penalized = 0

  const topMemories = db.prepare(`
    SELECT id, content, confidence, access_count, metadata FROM memories
    WHERE archived = 0 AND type IN ('episodic', 'semantic')
    AND (
      json_extract(metadata, '$.last_audit.at') IS NULL
      OR json_extract(metadata, '$.last_audit.at') < ?
    )
    ORDER BY access_count DESC, confidence DESC
    LIMIT 20
  `).all(now - 30 * 86400)

  for (const m of topMemories) {
    const prompt = `Avalie esta memória de um assistente pessoal (de 1 a 5):
"${m.content}"

Critérios:
- 5: Fato concreto, preciso, útil para respostas futuras
- 3: Informação vaga ou parcialmente útil
- 1: Genérico demais, irrelevante ou provavelmente desatualizado

Retorne APENAS JSON: {"score": 1-5, "feedback": "motivo curto"}`

    const raw = await callHaiku(prompt)
    if (!raw) continue

    let score = 3, feedback = ''
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        score = Math.max(1, Math.min(5, parseInt(parsed.score) || 3))
        feedback = String(parsed.feedback ?? '').slice(0, 120)
      }
    } catch { continue }

    let meta = {}
    try { meta = JSON.parse(m.metadata ?? '{}') } catch {}
    meta.last_audit = { score, feedback, at: now }

    if (score < 2) {
      const newConf = Math.max(0.05, m.confidence * 0.7)
      db.prepare(`UPDATE memories SET confidence=?, metadata=?, updated_at=? WHERE id=?`).run(newConf, JSON.stringify(meta), now, m.id)
      penalized++
    } else {
      db.prepare(`UPDATE memories SET metadata=?, updated_at=? WHERE id=?`).run(JSON.stringify(meta), now, m.id)
    }

    scheduleNextReview(m.id, score)
    audited++
  }

  let calibrationBuckets = 0
  try {
    const buckets = computeCalibration()
    calibrationBuckets = buckets.length
    if (buckets.length > 0) {
      const avgFactor = buckets.reduce((s, b) => s + b.calibration_factor, 0) / buckets.length
      logger.info({ buckets: buckets.length, avgFactor: avgFactor.toFixed(3) }, '[phase5] trust calibration computed')
    }
  } catch (err) { logger.warn({ err: err.message }, '[phase5] calibration error') }

  const summary = `🔍 *Self-audit semanal*\n${audited} memórias avaliadas\n${penalized} penalizadas\n📊 Calibração: ${calibrationBuckets} buckets computados`
  const owner = process.env.WHATSAPP_OWNER_JID
  if (owner && audited > 0) await sendWhatsApp(owner, summary).catch(() => {})

  logger.info({ audited, penalized }, '[phase5] self-audit concluído')
  return { audited, penalized }
}
