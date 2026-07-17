/**
 * Fase 6 — Ground-truth Mensal (1º de cada mês, 9h)
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { sendWhatsApp } from '../gateway/evolution.js'
import { logger } from '../logger.js'
import { snapshotMemoryVersion } from '../memory/index.js'

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

export async function runPhase6() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  let checked = 0, archived = 0

  const facts = db.prepare(`
    SELECT id, content, confidence, metadata FROM memories
    WHERE type IN ('semantic', 'episodic')
    AND category IN ('decision', 'person', 'project')
    AND archived = 0 AND confidence >= 0.5
    AND (
      json_extract(metadata, '$.ground_truth.at') IS NULL
      OR json_extract(metadata, '$.ground_truth.at') < ?
    )
    ORDER BY confidence DESC
    LIMIT 10
  `).all(now - 60 * 86400)

  for (const fact of facts) {
    const prompt = `Este fato ainda é verdade hoje?
"${fact.content}"

Fatos sobre projetos, decisões, pessoas e ferramentas podem mudar com o tempo.

Retorne APENAS JSON: {"still_true": true|false, "reason": "justificativa curta"}`

    const raw = await callHaiku(prompt)
    if (!raw) continue

    let stillTrue = true, reason = ''
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        stillTrue = parsed.still_true !== false
        reason = String(parsed.reason ?? '').slice(0, 150)
      }
    } catch { continue }

    let meta = {}
    try { meta = JSON.parse(fact.metadata ?? '{}') } catch {}
    meta.ground_truth = { still_true: stillTrue, reason, at: now }

    if (!stillTrue) {
      snapshotMemoryVersion(fact.id, `ground_truth_false: ${reason.slice(0, 60)}`)
      db.prepare(`UPDATE memories SET archived=1, metadata=?, updated_at=? WHERE id=?`).run(JSON.stringify(meta), now, fact.id)
      archived++
    } else {
      db.prepare(`UPDATE memories SET metadata=?, updated_at=? WHERE id=?`).run(JSON.stringify(meta), now, fact.id)
    }
    checked++
  }

  const summary = `🔎 *Ground-truth mensal*\n${checked} fatos verificados\n${archived} arquivados (possivelmente desatualizados)`
  const owner = process.env.WHATSAPP_OWNER_JID
  if (owner && checked > 0) await sendWhatsApp(owner, summary).catch(() => {})

  logger.info({ checked, archived }, '[phase6] ground-truth concluído')
  return { checked, archived }
}
