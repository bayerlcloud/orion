/**
 * Tiered Summarizer — 3 camadas de sumarização.
 *
 * Tier 1 — Extractive TF-IDF (sem LLM)
 * Tier 2 — Abstractive por categoria (Haiku, cache semanal)
 * Tier 3 — Narrativa por tema (Haiku, cache mensal)
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('tiered-sum')

function tokenFreq(text) {
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 3)
  const freq = new Map()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  return freq
}

function sentenceScore(sentence, docFreq, totalDocs) {
  const tokens = sentence.toLowerCase().split(/\W+/).filter(t => t.length > 3)
  if (tokens.length === 0) return 0
  let score = 0
  for (const t of tokens) {
    const tf = 1 / tokens.length
    const idf = Math.log(totalDocs / ((docFreq.get(t) ?? 0) + 1))
    score += tf * idf
  }
  return score / tokens.length
}

export function extractiveSummary(contents, limit = 5) {
  if (contents.length === 0) return []
  const totalDocs = contents.length
  const docFreq = new Map()
  for (const c of contents) {
    const tokens = new Set(c.toLowerCase().split(/\W+/).filter(t => t.length > 3))
    for (const t of tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  }
  const scored = contents.map((c, idx) => ({ content: c, idx, score: sentenceScore(c, docFreq, totalDocs) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.content)
}

export async function computeCategorySummary(category) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const weekAgo = now - 7 * 86400
  let cached = null
  try { cached = db.prepare(`SELECT summary, computed_at FROM tier2_summaries WHERE category=?`).get(category) } catch {}
  if (cached && cached.computed_at > weekAgo) return cached.summary

  const mems = db.prepare(`SELECT content FROM memories WHERE category=? AND archived=0 AND confidence>0.3 ORDER BY confidence DESC, access_count DESC LIMIT 30`).all(category)
  if (mems.length === 0) return null

  const list = mems.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
  const prompt = `Resuma estas memórias em 1-2 frases concisas, na 2ª pessoa, focando nos padrões consistentes:\n\nCategoria: ${category}\nMemórias:\n${list}\n\nResumo (1-2 frases, começa com "Você"):`

  try {
    const r = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'], { timeout: 30_000 })
    const text = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    if (!text) return null
    try { db.prepare(`INSERT INTO tier2_summaries (category, summary, sample_count, computed_at) VALUES (?, ?, ?, ?) ON CONFLICT(category) DO UPDATE SET summary=excluded.summary, sample_count=excluded.sample_count, computed_at=excluded.computed_at`).run(category, text, mems.length, now) } catch {}
    log.info({ category, samples: mems.length }, '[tier2] concluída')
    return text
  } catch (err) { log.debug({ err: err.message }, '[tier2] erro'); return null }
}

export function getCategorySummary(category) {
  const db = getDb()
  try { return db.prepare('SELECT summary FROM tier2_summaries WHERE category=?').get(category)?.summary ?? null } catch { return null }
}

export async function refreshAllCategorySummaries() {
  const db = getDb()
  const categories = db.prepare(`SELECT DISTINCT category FROM memories WHERE archived=0`).all().map(r => r.category)
  let computed = 0
  for (const cat of categories) { try { await computeCategorySummary(cat); computed++ } catch {} }
  return computed
}

export async function computeNarrativeSummary(theme) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const monthAgo = now - 30 * 86400
  let cached = null
  try { cached = db.prepare('SELECT narrative, computed_at FROM tier3_narratives WHERE theme=?').get(theme) } catch {}
  if (cached && cached.computed_at > monthAgo) return cached.narrative

  let mems = []
  try { mems = db.prepare(`SELECT content, created_at FROM memories WHERE archived=0 AND (content LIKE ? OR tags LIKE ?) ORDER BY created_at ASC LIMIT 40`).all(`%${theme}%`, `%${theme}%`) } catch {}
  if (mems.length < 3) return null

  const timeline = mems.map(m => `[${new Date(m.created_at * 1000).toLocaleDateString('pt-BR')}] ${m.content}`).join('\n')
  const prompt = `Escreva um parágrafo narrativo conciso (3-5 frases) sobre como o usuário evoluiu em relação a "${theme}" ao longo do tempo:\n\n${timeline}\n\nNarrativa:`

  try {
    const r = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'], { timeout: 45_000 })
    const narrative = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    if (!narrative) return null
    try { db.prepare(`INSERT INTO tier3_narratives (theme, narrative, computed_at) VALUES (?, ?, ?) ON CONFLICT(theme) DO UPDATE SET narrative=excluded.narrative, computed_at=excluded.computed_at`).run(theme, narrative, now) } catch {}
    return narrative
  } catch { return null }
}

export function getNarrativeSummary(theme) {
  const db = getDb()
  try { return db.prepare('SELECT narrative FROM tier3_narratives WHERE theme=?').get(theme)?.narrative ?? null } catch { return null }
}
