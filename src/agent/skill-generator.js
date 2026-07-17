/**
 * Gerador de skills automáticas.
 *
 * Após cada troca significativa, detecta se foi resolvido algo reutilizável
 * e persiste como skill no SQLite. Antes de cada resposta, busca skills
 * relevantes e injeta no contexto.
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'

import { createLogger } from '../logger.js'
const log = createLogger('skills')

// ── Busca skills relevantes por BM25 ─────────────────────────────────────────

export function retrieveSkills(query, { limit = 4 } = {}) {
  if (!query || query.trim().length < 10) return []
  try {
    const db = getDb()
    // FTS via LIKE no conteúdo — o DB não tem FTS dedicado para skills, usamos LIKE
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 6)
    if (words.length === 0) return []
    const conditions = words.map(() => `(lower(name) LIKE ? OR lower(description) LIKE ? OR lower(content) LIKE ?)`).join(' OR ')
    const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`])
    const rows = db.prepare(`
      SELECT id, name, description, content, usage_count
      FROM skills
      WHERE ${conditions}
      ORDER BY usage_count DESC, updated_at DESC
      LIMIT ?
    `).all(...params, limit)
    return rows
  } catch {
    return []
  }
}

export function buildSkillContext(skills) {
  if (!skills.length) return ''
  const lines = ['<skills_relevantes>']
  for (const s of skills) {
    lines.push(`## ${s.name}`)
    lines.push(s.description)
    if (s.content) lines.push(s.content)
    lines.push('')
  }
  lines.push('</skills_relevantes>')
  return '\n\n' + lines.join('\n')
}

// Incrementa contador de uso
export function markSkillUsed(skillId) {
  try {
    getDb().prepare(`UPDATE skills SET usage_count = usage_count + 1, updated_at = unixepoch() WHERE id = ?`).run(skillId)
  } catch {}
}

// ── Geração pós-turno ─────────────────────────────────────────────────────────

// Heurística: vale a pena gerar skill?
function isSkillWorthy(userMessage, assistantResponse) {
  const u = userMessage.trim()
  const a = assistantResponse.trim()
  // Muito curto = saudação/pergunta simples
  if (u.length < 30 || a.length < 100) return false
  // Resposta com código, comandos, URLs = provavelmente útil
  const hasCode  = a.includes('```') || a.includes('`') || a.includes('$ ')
  const hasSteps = /\d+\.\s/.test(a) || a.includes('•') || a.includes('→')
  const hasTech  = /docker|pm2|nginx|caddy|python|node|npm|git|ssh|curl|api|webhook/i.test(a)
  return hasCode || hasSteps || hasTech
}

export async function generateSkillIfWorthy(userMessage, assistantResponse) {
  if (!isSkillWorthy(userMessage, assistantResponse)) return null

  const prompt = `Analise este par de pergunta/resposta e decida se representa um padrão reutilizável que vale persistir como skill.

PERGUNTA: ${userMessage.slice(0, 500)}

RESPOSTA: ${assistantResponse.slice(0, 1000)}

Se vale a pena persistir, responda SOMENTE com JSON no formato:
{
  "worth": true,
  "name": "nome curto da skill em kebab-case",
  "description": "1 linha descrevendo quando usar esta skill",
  "content": "o padrão, comando, abordagem ou snippet resumido (máx 400 chars)"
}

Se não vale a pena (saudação, pergunta simples, resposta trivial), responda:
{"worth": false}

Responda APENAS o JSON, sem mais nada.`

  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000 })

    const parsed = JSON.parse(result.stdout)
    const text = parsed.result ?? parsed.content ?? ''
    const json = JSON.parse(text.trim())
    if (!json.worth || !json.name) return null

    const db = getDb()
    const id = crypto.randomUUID()

    // Upsert: se já existe skill com mesmo nome, atualiza
    const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(json.name)
    if (existing) {
      db.prepare(`UPDATE skills SET description = ?, content = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(json.description, json.content, existing.id)
      log.info(`[skills] atualizada: ${json.name}`)
      return existing.id
    }

    db.prepare(`
      INSERT INTO skills (id, name, description, content, usage_count, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0.8, unixepoch(), unixepoch())
    `).run(id, json.name, json.description, json.content)

    log.info(`[skills] nova skill: ${json.name}`)
    return id
  } catch {
    return null
  }
}
