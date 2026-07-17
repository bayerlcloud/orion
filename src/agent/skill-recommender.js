import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('recommender')

export function recordSkillUsage(skillName, sessionId = null) {
  const db = getDb()
  try {
    db.prepare(`UPDATE skills SET usage_count = usage_count + 1, last_used_at = unixepoch() WHERE name = ?`).run(skillName)
    if (sessionId) {
      db.prepare(`
        INSERT OR IGNORE INTO skill_session_usage (skill_name, session_id, used_at)
        VALUES (?, ?, unixepoch())
      `).run(skillName, sessionId)
    }
  } catch {}
}

export function updateCoUsageMatrix(usedSkills) {
  if (!usedSkills || usedSkills.length < 2) return
  const db = getDb()
  for (let i = 0; i < usedSkills.length; i++) {
    for (let j = i + 1; j < usedSkills.length; j++) {
      const [a, b] = [usedSkills[i], usedSkills[j]].sort()
      try {
        db.prepare(`
          INSERT INTO skill_co_usage (skill_a, skill_b, co_count, last_at)
          VALUES (?, ?, 1, unixepoch())
          ON CONFLICT(skill_a, skill_b) DO UPDATE SET
            co_count = co_count + 1, last_at = unixepoch()
        `).run(a, b)
      } catch {}
    }
  }
}

export function recommendSkills(skillName, alreadyUsed = [], limit = 5) {
  const db = getDb()
  try {
    const coUsed = db.prepare(`
      SELECT
        CASE WHEN skill_a = ? THEN skill_b ELSE skill_a END AS recommended,
        co_count
      FROM skill_co_usage
      WHERE skill_a = ? OR skill_b = ?
      ORDER BY co_count DESC
      LIMIT ?
    `).all(skillName, skillName, skillName, limit * 2)

    const usedSet = new Set(alreadyUsed)
    const recommendations = coUsed
      .filter(r => !usedSet.has(r.recommended))
      .map(r => ({ name: r.recommended, score: r.co_count, reason: `co-usada com ${skillName}` }))

    if (recommendations.length < limit) {
      const prefix = skillName.split('-')[0]
      const popular = db.prepare(`
        SELECT name, usage_count FROM skills
        WHERE name LIKE ? AND name != ? AND status = 'active'
        ORDER BY usage_count DESC LIMIT ?
      `).all(`${prefix}-%`, skillName, limit - recommendations.length)

      for (const p of popular) {
        if (!usedSet.has(p.name) && !recommendations.some(r => r.name === p.name)) {
          recommendations.push({ name: p.name, score: p.usage_count * 0.5, reason: 'mesma família' })
        }
      }
    }

    return recommendations.slice(0, limit)
  } catch { return [] }
}

export function getTopSkills(limit = 10) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT name, description, usage_count, confidence
      FROM skills WHERE status = 'active'
      ORDER BY usage_count DESC LIMIT ?
    `).all(limit)
  } catch { return [] }
}

export function suggestSkillsForMessage(message, limit = 3) {
  const db = getDb()
  const words = message.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  if (words.length === 0) return []
  try {
    const results = db.prepare(`
      SELECT name, description, usage_count,
        (${words.map(() => `(name LIKE ? OR description LIKE ?) * 1`).join(' + ')}) AS relevance
      FROM skills
      WHERE status = 'active'
      HAVING relevance > 0
      ORDER BY relevance DESC, usage_count DESC
      LIMIT ?
    `).all(...words.flatMap(w => [`%${w}%`, `%${w}%`]), limit)
    return results.map(r => ({ name: r.name, description: r.description, score: r.relevance, reason: 'match por keyword' }))
  } catch { return [] }
}
