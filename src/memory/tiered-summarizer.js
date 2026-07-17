/**
 * Tiered Summarizer — 3 camadas de sumarização para escalar a 10k+ memórias.
 *
 * Tier 1 — Extractive (sem LLM, instantâneo):
 *   Retorna as N frases mais relevantes por TF-IDF simplificado.
 *   Usado quando contexto já está grande e não cabe mais texto.
 *
 * Tier 2 — Abstractive por categoria (Haiku, cache semanal):
 *   Resume todas as memórias de uma categoria em 1-2 frases.
 *   Ex: "Você prefere Vim, dark themes e fontes mono grandes"
 *   Cache em tier2_summaries, recomputed toda semana na phase3.
 *
 * Tier 3 — Narrativa (Sonnet, cache mensal):
 *   Parágrafo narrative sobre a evolução de um tema ao longo do tempo.
 *   "Ao longo de 2025, suas preferências de ferramentas evoluíram de..."
 *   Cache em tier3_narratives.
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('tiered-sum')

// ── Tier 1: Extractive ───────────────────────────────────────────────────────

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

/**
 * Tier 1: retorna as N sentenças/fatos mais informativos (sem LLM).
 * @param {string[]} contents - lista de conteúdos de memória
 * @param {number} limit
 */
export function extractiveSummary(contents, limit = 5) {
  if (contents.length === 0) return []
  const totalDocs = contents.length
  const docFreq = new Map()
  for (const c of contents) {
    const tokens = new Set(c.toLowerCase().split(/\W+/).filter(t => t.length > 3))
    for (const t of tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  }

  const scored = contents.map((c, idx) => ({
    content: c,
    idx,
    score: sentenceScore(c, docFreq, totalDocs),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.content)
}

// ── Tier 2: Abstractive por categoria ────────────────────────────────────────

/**
 * Gera e armazena sumarização abstractive de uma categoria (cache semanal).
 */
export async function computeCategorySummary(category) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const weekAgo = now - 7 * 86400

  // Verifica cache
  let cached = null
  try {
    cached = db.prepare(`
      SELECT summary, computed_at FROM tier2_summaries WHERE category = ?
    `).get(category)
  } catch {}

  if (cached && cached.computed_at > weekAgo) return cached.summary

  // Busca memórias da categoria
  const mems = db.prepare(`
    SELECT content FROM memories
    WHERE category = ? AND archived = 0 AND confidence > 0.3
    ORDER BY confidence DESC, access_count DESC
    LIMIT 30
  `).all(category)

  if (mems.length === 0) return null

  const list = mems.map((m, i) => `${i + 1}. ${m.content}`).join('\n')

  const prompt = `Resuma estas memórias sobre Danilo em 1-2 frases concisas, na 2ª pessoa, focando nos padrões consistentes:

Categoria: ${category}
Memórias:
${list}

Resumo (1-2 frases, começa com "Você"):`.trim()

  try {
    const r = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000 })

    const text = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    if (!text) return null

    // Salva cache
    try {
      db.prepare(`
        INSERT INTO tier2_summaries (category, summary, sample_count, computed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(category) DO UPDATE SET summary=excluded.summary, sample_count=excluded.sample_count, computed_at=excluded.computed_at
      `).run(category, text, mems.length, now)
    } catch {}

    log.info({ category, samples: mems.length }, '[tier2] sumarização abstractive concluída')
    return text
  } catch (err) {
    log.debug({ err: err.message }, '[tier2] erro na sumarização')
    return null
  }
}

/**
 * Retorna o sumário tier2 de uma categoria se disponível (do cache).
 */
export function getCategorySummary(category) {
  const db = getDb()
  try {
    const row = db.prepare('SELECT summary FROM tier2_summaries WHERE category = ?').get(category)
    return row?.summary ?? null
  } catch { return null }
}

/**
 * Recomputa todos os sumários tier2 atrasados (chamado pela Fase 3).
 */
export async function refreshAllCategorySummaries() {
  const db = getDb()
  const categories = db.prepare(`
    SELECT DISTINCT category FROM memories WHERE archived = 0
  `).all().map(r => r.category)

  let computed = 0
  for (const cat of categories) {
    try {
      await computeCategorySummary(cat)
      computed++
    } catch {}
  }
  return computed
}

// ── Tier 3: Narrativa ─────────────────────────────────────────────────────────

/**
 * Gera narrativa de alto nível sobre a evolução de um tema (cache mensal).
 */
export async function computeNarrativeSummary(theme) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const monthAgo = now - 30 * 86400

  let cached = null
  try {
    cached = db.prepare('SELECT narrative, computed_at FROM tier3_narratives WHERE theme = ?').get(theme)
  } catch {}

  if (cached && cached.computed_at > monthAgo) return cached.narrative

  // Busca memórias relacionadas ao tema
  let mems = []
  try {
    mems = db.prepare(`
      SELECT content, created_at FROM memories
      WHERE archived = 0 AND (content LIKE ? OR tags LIKE ?)
      ORDER BY created_at ASC LIMIT 40
    `).all(`%${theme}%`, `%${theme}%`)
  } catch {}

  if (mems.length < 3) return null

  const timeline = mems.map(m => {
    const date = new Date(m.created_at * 1000).toLocaleDateString('pt-BR')
    return `[${date}] ${m.content}`
  }).join('\n')

  const prompt = `Escreva um parágrafo narrativo conciso (3-5 frases) sobre como o Danilo evoluiu em relação a "${theme}" ao longo do tempo, baseado nestes registros cronológicos. Foco em mudanças, decisões e aprendizados:

${timeline}

Narrativa:`.trim()

  try {
    const r = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 45_000 })

    const narrative = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    if (!narrative) return null

    try {
      db.prepare(`
        INSERT INTO tier3_narratives (theme, narrative, computed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(theme) DO UPDATE SET narrative=excluded.narrative, computed_at=excluded.computed_at
      `).run(theme, narrative, now)
    } catch {}

    log.info({ theme }, '[tier3] narrativa gerada')
    return narrative
  } catch { return null }
}

export function getNarrativeSummary(theme) {
  const db = getDb()
  try {
    const row = db.prepare('SELECT narrative FROM tier3_narratives WHERE theme = ?').get(theme)
    return row?.narrative ?? null
  } catch { return null }
}
