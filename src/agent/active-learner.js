import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { logger } from '../logger.js'

const PRIORITY_ORDER = ['person', 'decision', 'user_pref', 'project', 'tool', 'general']
const COVERAGE_MIN = 3
const MIN_INTERVAL_SECS = 6 * 3600

export function checkAndQueueQuestion(contextSnippet = '') {
  setImmediate(async () => {
    try {
      const db = getDb()
      const now = Math.floor(Date.now() / 1000)

      const categoryCounts = db.prepare(`
        SELECT category, COUNT(*) AS n FROM memories WHERE archived = 0 GROUP BY category
      `).all()

      const totalMemories = categoryCounts.reduce((s, r) => s + r.n, 0)
      if (totalMemories < 5) return

      const lowCats = categoryCounts.filter(r => r.n < COVERAGE_MIN)
      if (lowCats.length === 0) return

      const sorted = lowCats.sort((a, b) =>
        PRIORITY_ORDER.indexOf(a.category) - PRIORITY_ORDER.indexOf(b.category)
      )

      const target = sorted[0]

      const existing = db.prepare(`
        SELECT id FROM proactive_questions
        WHERE category = ? AND (answered = 0 OR answered_at > ?)
        LIMIT 1
      `).get(target.category, now - MIN_INTERVAL_SECS)
      if (existing) return

      const prompt = `Você é um assistente pessoal que quer conhecer melhor o usuário.

Categoria com pouca informação: ${target.category} (apenas ${target.n} memórias)
Contexto recente: ${String(contextSnippet ?? '').slice(0, 200)}

Gere UMA pergunta natural e específica para aprender algo útil sobre o usuário nessa categoria.
A pergunta deve ser:
- Conversacional (não interrogatória)
- Específica o suficiente para ter uma resposta concreta
- Relevante ao contexto atual se possível

Retorne APENAS a pergunta, sem prefixo ou explicação.`

      const result = await execa('claude', [
        '-p', prompt,
        '--model', 'claude-haiku-4-5-20251001',
        '--output-format', 'json',
        '--dangerously-skip-permissions',
      ], { timeout: 15_000 })

      const raw = JSON.parse(result.stdout)
      const question = (raw.result ?? raw.content ?? '').trim()
      if (!question || question.length < 10) return

      db.prepare(`
        INSERT INTO proactive_questions (question, category, context)
        VALUES (?, ?, ?)
      `).run(question, target.category, String(contextSnippet ?? '').slice(0, 100))

      logger.debug({ category: target.category, question: question.slice(0, 60) }, '[active-learner] pergunta enfileirada')
    } catch (err) {
      logger.debug({ err: err.message }, '[active-learner] erro silencioso')
    }
  })
}

export function getPendingQuestion() {
  const db = getDb()
  return db.prepare(`
    SELECT id, question, category FROM proactive_questions
    WHERE answered = 0
    ORDER BY created_at ASC
    LIMIT 1
  `).get() ?? null
}

export function markQuestionAnswered(id) {
  const db = getDb()
  try {
    db.prepare(`UPDATE proactive_questions SET answered = 1, answered_at = unixepoch() WHERE id = ?`).run(id)
  } catch {}
}
