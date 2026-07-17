/**
 * Fase 2 — Dedup + Decay (roda a cada 30 min via node-cron)
 * Sem LLM. Usa BM25 para detectar duplicatas e decai memórias antigas.
 * Melhoria 2: soft delete em vez de DELETE físico.
 * Melhoria 6: detecção de contradições com Haiku.
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { DECAY_RATES } from '../memory/decay-config.js'

const SIMILARITY_THRESHOLD = 0.75
const PROMOTE_THRESHOLD = 0.4   // raw → episodic
const ARCHIVE_THRESHOLD = 0.05  // confidence mínima para sobreviver

function tokenize(text) {
  return text.toLowerCase().replace(/[^\wà-ú]/g, ' ').split(/\s+/).filter(Boolean)
}

function bm25Similarity(a, b) {
  const tokA = new Set(tokenize(a))
  const tokB = new Set(tokenize(b))
  const intersection = [...tokA].filter(t => tokB.has(t)).length
  return intersection / (Math.sqrt(tokA.size) * Math.sqrt(tokB.size) + 0.01)
}

// ── Melhoria 6: Detecção de contradições ─────────────────────────────────────

async function callHaiku(prompt) {
  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000 })
    const parsed = JSON.parse(result.stdout)
    return (parsed.result ?? parsed.content ?? '').trim()
  } catch {
    return null
  }
}

async function detectContradictions() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  // Busca memórias de alta confiança com conteúdo substancial
  const candidates = db.prepare(`
    SELECT id, content, confidence, metadata FROM memories
    WHERE confidence >= 0.6 AND archived = 0
    AND type IN ('episodic', 'semantic')
    ORDER BY confidence DESC
    LIMIT 80
  `).all()

  if (candidates.length < 2) return 0

  // Encontra pares que compartilham entidades (word overlap ≥ 2 palavras longas)
  const pairs = []
  for (let i = 0; i < candidates.length && pairs.length < 20; i++) {
    const a = candidates[i]
    const wordsA = new Set(a.content.toLowerCase().split(/\s+/).filter(w => w.length > 4))
    for (let j = i + 1; j < candidates.length && pairs.length < 20; j++) {
      const b = candidates[j]
      const wordsB = new Set(b.content.toLowerCase().split(/\s+/).filter(w => w.length > 4))
      const shared = [...wordsA].filter(w => wordsB.has(w)).length
      if (shared >= 2) {
        pairs.push([a, b])
      }
    }
  }

  // Limita a 10 pares por rodada
  const toCheck = pairs.slice(0, 10)
  let contradictions = 0

  for (const [memA, memB] of toCheck) {
    const prompt = `Estas duas afirmações se contradizem? Responda apenas: SIM ou NAO
A: ${memA.content}
B: ${memB.content}`

    const answer = await callHaiku(prompt)
    if (!answer) continue

    if (answer.toUpperCase().startsWith('SIM')) {
      // Reduz confiança de ambas e marca no metadata
      const newConfA = Math.max(0, memA.confidence - 0.1)
      const newConfB = Math.max(0, memB.confidence - 0.1)

      let metaA = {}
      let metaB = {}
      try { metaA = JSON.parse(memA.metadata ?? '{}') } catch {}
      try { metaB = JSON.parse(memB.metadata ?? '{}') } catch {}
      metaA.contradiction_with = memB.id
      metaB.contradiction_with = memA.id

      db.prepare(`
        UPDATE memories SET confidence = ?, metadata = ?, updated_at = ? WHERE id = ?
      `).run(newConfA, JSON.stringify(metaA), now, memA.id)
      db.prepare(`
        UPDATE memories SET confidence = ?, metadata = ?, updated_at = ? WHERE id = ?
      `).run(newConfB, JSON.stringify(metaB), now, memB.id)

      contradictions++
    }
  }

  return contradictions
}

export async function runPhase2() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  let deduped = 0, decayed = 0, promoted = 0, archived = 0

  // ── 1. Dedup: raw recentes vs episodic/semantic existentes ──────────────────
  const rawRecent = db.prepare(`
    SELECT * FROM memories WHERE type = 'raw' AND archived = 0
    AND created_at > ? ORDER BY created_at DESC
  `).all(now - 1800)  // últimos 30 min

  const episodic = db.prepare(`
    SELECT * FROM memories WHERE type IN ('episodic','semantic') AND archived = 0
    ORDER BY confidence DESC LIMIT 200
  `).all()

  for (const raw of rawRecent) {
    for (const existing of episodic) {
      const sim = bm25Similarity(raw.content, existing.content)
      if (sim > SIMILARITY_THRESHOLD) {
        // bumpar confiança do existente, soft-delete a duplicata
        db.prepare(`
          UPDATE memories SET confidence = MIN(0.95, confidence + 0.05),
            access_count = access_count + 1, updated_at = ?
          WHERE id = ?
        `).run(now, existing.id)
        // Melhoria 2: soft delete em vez de DELETE físico
        db.prepare(`
          UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?
        `).run(now, raw.id)
        deduped++
        break
      }
    }
  }

  // ── 2. Decay: reduz confiança de memórias velhas sem acesso ─────────────────
  const old = db.prepare(`
    SELECT id, confidence, category, last_accessed, created_at FROM memories
    WHERE type != 'skill' AND confidence > ? AND archived = 0
  `).all(ARCHIVE_THRESHOLD)

  for (const m of old) {
    const lastSeen = m.last_accessed ?? m.created_at
    const agedays = (now - lastSeen) / 86400
    if (agedays < 1) continue
    const rate = DECAY_RATES[m.category] ?? DECAY_RATES.general
    const decay = rate * agedays
    const newConf = Math.max(0, m.confidence - decay)
    db.prepare(`UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?`).run(newConf, now, m.id)
    decayed++
  }

  // ── 3. Promover: raw com confiança suficiente → episodic ────────────────────
  const toPromote = db.prepare(`
    SELECT id FROM memories WHERE type = 'raw' AND confidence >= ? AND archived = 0
  `).all(PROMOTE_THRESHOLD)

  for (const { id } of toPromote) {
    db.prepare(`UPDATE memories SET type = 'episodic', updated_at = ? WHERE id = ?`).run(now, id)
    promoted++
  }

  // ── 4. Arquivar (soft delete): confidence muito baixa + sem acesso recente ───
  const cutoff = now - 30 * 86400  // 30 dias
  const toArchive = db.prepare(`
    SELECT id FROM memories
    WHERE confidence < ? AND (last_accessed IS NULL OR last_accessed < ?)
    AND type != 'skill' AND archived = 0
  `).all(ARCHIVE_THRESHOLD, cutoff)

  for (const { id } of toArchive) {
    // Melhoria 2: soft delete em vez de DELETE físico
    db.prepare(`UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?`).run(now, id)
    archived++
  }

  // ── 5. Detecção de contradições (Melhoria 6) ─────────────────────────────────
  let contradictions = 0
  try {
    contradictions = await detectContradictions()
  } catch (err) {
    console.error('[phase2] contradiction detection error:', err.message)
  }

  console.log(`[phase2] dedup:${deduped} decay:${decayed} promoted:${promoted} archived:${archived} contradictions:${contradictions}`)
  return { deduped, decayed, promoted, archived, contradictions }
}
