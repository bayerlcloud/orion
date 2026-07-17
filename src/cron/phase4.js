/**
 * Fase 4 — Daily (meia-noite): arquivo, sync vault, relatório WhatsApp
 */

import { getDb } from '../db/index.js'
import { sendWhatsApp } from '../gateway/evolution.js'
import { scheduleNextReview } from '../memory/index.js'
import { logger } from '../logger.js'

export async function runPhase4() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const owner = process.env.WHATSAPP_OWNER_JID
  let archived = 0

  const cutoff = now - 90 * 86400
  const { changes } = db.prepare(`DELETE FROM memories WHERE confidence < 0.05 AND access_count = 0 AND created_at < ?`).run(cutoff)
  archived = changes

  const stale30 = now - 30 * 86400
  const skill90 = now - 90 * 86400
  let skillsArchived = 0, skillsStale = 0, skillsReactivated = 0
  try {
    skillsArchived = db.prepare(`UPDATE skills SET status = 'archived' WHERE status != 'archived' AND COALESCE(last_used_at, created_at) < ?`).run(skill90).changes
    skillsStale = db.prepare(`UPDATE skills SET status = 'stale' WHERE status = 'active' AND COALESCE(last_used_at, created_at) < ?`).run(stale30).changes
    skillsReactivated = db.prepare(`UPDATE skills SET status = 'active' WHERE status = 'stale' AND last_used_at IS NOT NULL AND last_used_at > ?`).run(stale30).changes
  } catch (_e) {}

  let reviewScheduled = 0
  try {
    const overdueReviews = db.prepare(`SELECT id, confidence FROM memories WHERE archived = 0 AND next_review_at IS NOT NULL AND next_review_at < ? LIMIT 30`).all(now)
    for (const m of overdueReviews) {
      const quality = m.confidence >= 0.7 ? 4 : m.confidence >= 0.4 ? 3 : 2
      scheduleNextReview(m.id, quality)
      reviewScheduled++
    }
  } catch (_e) {}

  const anomalies = []
  try {
    const recentContr = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE created_at > ? AND json_extract(metadata, '$.contradiction_with') IS NOT NULL`).get(now - 86400).n
    const prevContr = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE created_at > ? AND created_at <= ? AND json_extract(metadata, '$.contradiction_with') IS NOT NULL`).get(now - 172800, now - 86400).n
    if (recentContr > 0 && recentContr > prevContr * 2 + 3) anomalies.push(`⚠️ Contradiction spike: ${recentContr} no último dia (era ${prevContr})`)
    const recentAvgConf = db.prepare(`SELECT AVG(confidence) AS avg FROM memories WHERE archived = 0 AND created_at > ?`).get(now - 7 * 86400).avg ?? 0
    const prevAvgConf = db.prepare(`SELECT AVG(confidence) AS avg FROM memories WHERE archived = 0 AND created_at <= ?`).get(now - 7 * 86400).avg ?? 0
    if (prevAvgConf > 0.05 && recentAvgConf < prevAvgConf * 0.85) anomalies.push(`⚠️ Confidence drop: ${Math.round(prevAvgConf * 100)}% → ${Math.round(recentAvgConf * 100)}%`)
  } catch (_e) {}

  if (anomalies.length > 0) {
    logger.warn({ anomalies }, '[phase4] anomalias detectadas')
    if (owner) await sendWhatsApp(owner, `🔔 *Orion — Anomalias detectadas*\n${anomalies.join('\n')}`).catch(() => {})
  }

  const stats = {
    memories: db.prepare(`SELECT COUNT(*) AS n FROM memories`).get().n,
    byType: db.prepare(`SELECT type, COUNT(*) AS n FROM memories GROUP BY type`).all(),
    sessions24h: db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE last_active > ?`).get(now - 86400).n,
    messages24h: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE created_at > ?`).get(now - 86400).n,
    skills: db.prepare(`SELECT COUNT(*) AS n FROM skills`).get().n,
    activeCrons: db.prepare(`SELECT COUNT(*) AS n FROM cron_jobs WHERE status = 'active'`).get().n,
  }

  const typeStr = stats.byType.map(r => `${r.n} ${r.type}`).join(' · ')

  if (owner) {
    const skillLifecycleStr = (skillsStale > 0 || skillsArchived > 0 || skillsReactivated > 0)
      ? `\n🔄 Skills: ${skillsStale} stale · ${skillsArchived} arquivadas · ${skillsReactivated} reativadas`
      : ''
    const report = `🧠 *Orion — Relatório Diário*\n\n📊 Memórias: ${stats.memories} (${typeStr})\n💬 Sessões 24h: ${stats.sessions24h} · Mensagens: ${stats.messages24h}\n⚡ Skills: ${stats.skills} · Crons ativos: ${stats.activeCrons}\n🗑 Arquivadas hoje: ${archived}${skillLifecycleStr}\n\n_Sistema funcionando normalmente_`
    try { await sendWhatsApp(owner, report) } catch (e) { console.error('[phase4] Erro ao enviar relatório:', e.message) }
  }

  console.log(`[phase4] archived:${archived} skills_stale:${skillsStale} skills_archived:${skillsArchived} skills_reactivated:${skillsReactivated}`)
  return { archived, skillsStale, skillsArchived, skillsReactivated, stats }
}
