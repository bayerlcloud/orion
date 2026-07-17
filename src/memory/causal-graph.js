/**
 * Causal Graph — armazena asserções causais entre fatos/eventos.
 *
 * Estrutura: (cause, effect, confidence, evidence_memory_id)
 * Ex: "adicionamos cache" → "performance melhorou" (conf=0.8)
 *
 * Permite:
 *   - Q: "O que causou a melhora de performance?" → via getEffects()
 *   - Q: "O que aconteceria se remover o cache?" → via getEffects(cause)
 *   - Detectar correlações vs causações nos fatos do usuário
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { emitBrain } from '../brain-events.js'
import { createLogger } from '../logger.js'
const log = createLogger('causal')

// Padrões linguísticos que indicam causalidade em pt-BR
const CAUSAL_PATTERNS = [
  /\b(causou|fez com que|levou a|resultou em|gerou|provocou)\b/gi,
  /\bpor\s+causa\s+d[aeo]\b/gi,
  /\bdevido\s+a\b/gi,
  /\bpor\s+isso\b/gi,
  /\bpor\s+conta\s+d[aeo]\b/gi,
  /\bmelhorou\s+(?:depois|após|com)\b/gi,
  /\bpiorou\s+(?:depois|após|com)\b/gi,
  /\bse\s+(?:você|eu|a gente)\s+\w+.*então\b/gi,
]

export function hasCausalSignal(text) {
  return CAUSAL_PATTERNS.some(re => {
    re.lastIndex = 0
    return re.test(text)
  })
}

/**
 * Salva uma asserção causal.
 */
export function saveCausalLink({ cause, effect, confidence = 0.6, evidenceMemoryId = null }) {
  const db = getDb()
  try {
    db.prepare(`
      INSERT INTO causal_links (cause, effect, confidence, evidence_memory_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cause, effect) DO UPDATE SET
        confidence = MAX(confidence, excluded.confidence),
        evidence_memory_id = COALESCE(excluded.evidence_memory_id, evidence_memory_id),
        updated_at = unixepoch()
    `).run(cause, effect, confidence, evidenceMemoryId ?? null)
    emitBrain('causal', { text: `${cause} → ${effect}`, confidence })
    return true
  } catch { return false }
}

/**
 * Extrai asserções causais de um texto via Haiku (background).
 */
export async function extractCausalLinks(text, memoryId = null) {
  if (!hasCausalSignal(text)) return 0

  try {
    const prompt = `Extraia asserções causais do texto abaixo no formato JSON.
Retorne APENAS JSON com: {"links": [{"cause": "...", "effect": "...", "confidence": 0.0-1.0}]}
Máximo 3 links. Se não houver causalidade clara, retorne {"links": []}.

Texto: "${text.slice(0, 500)}"`

    const r = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 20_000 })

    const raw = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    const parsed = JSON.parse(raw)
    const links = parsed.links ?? []

    let saved = 0
    for (const l of links.slice(0, 3)) {
      if (l.cause && l.effect) {
        saveCausalLink({ cause: l.cause, effect: l.effect, confidence: l.confidence ?? 0.6, evidenceMemoryId: memoryId })
        saved++
      }
    }
    return saved
  } catch { return 0 }
}

/** Retorna os efeitos conhecidos de uma causa. */
export function getEffects(cause, limit = 10) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT effect, confidence, evidence_memory_id
      FROM causal_links WHERE cause LIKE ? ORDER BY confidence DESC LIMIT ?
    `).all(`%${cause}%`, limit)
  } catch { return [] }
}

/** Retorna as causas conhecidas de um efeito. */
export function getCauses(effect, limit = 10) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT cause, confidence, evidence_memory_id
      FROM causal_links WHERE effect LIKE ? ORDER BY confidence DESC LIMIT ?
    `).all(`%${effect}%`, limit)
  } catch { return [] }
}

/** Lista todos os links causais. */
export function listCausalLinks(limit = 50) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT * FROM causal_links ORDER BY confidence DESC LIMIT ?
    `).all(limit)
  } catch { return [] }
}

// ── U2: Reasoning contrafactual — travessia recursiva do DAG causal ───────────

/**
 * Walk recursivo forward: dado uma causa, encontra toda a cadeia de efeitos
 * downstream (efeitos dos efeitos), com confiança em cascata.
 *
 * Ex: "remover cache" → "performance piora" → "usuários reclamam" → "churn sobe"
 *
 * @param {string} cause - causa raiz (busca por LIKE)
 * @param {object} opts
 * @param {number} opts.maxDepth - profundidade máxima (default 5)
 * @param {number} opts.decayPerHop - fator de decaimento de confiança por salto (default 0.8)
 */
export function traceCausalChain(cause, { maxDepth = 5, decayPerHop = 0.8 } = {}) {
  const db = getDb()
  const visited = new Set()
  const chain = []

  function walk(currentEffect, depth, cumulativeConf) {
    if (depth > maxDepth) return
    let rows = []
    try {
      rows = db.prepare(`
        SELECT effect, confidence FROM causal_links
        WHERE cause LIKE ? ORDER BY confidence DESC LIMIT 5
      `).all(`%${currentEffect}%`)
    } catch { return }

    for (const row of rows) {
      const key = `${currentEffect}→${row.effect}`
      if (visited.has(key)) continue
      visited.add(key)

      const propagatedConf = cumulativeConf * row.confidence * decayPerHop
      chain.push({
        depth,
        cause: currentEffect,
        effect: row.effect,
        link_confidence: row.confidence,
        propagated_confidence: Math.round(propagatedConf * 1000) / 1000,
      })

      walk(row.effect, depth + 1, propagatedConf)
    }
  }

  walk(cause, 1, 1.0)
  return chain
}

/**
 * Reasoning contrafactual: "O que aconteceria se X não tivesse ocorrido?"
 *
 * Caminha forward a partir da causa removida, marcando todos os efeitos
 * downstream como "incertos" (confiança reduzida em cascata).
 *
 * @param {string} removedCause - a causa hipoteticamente removida
 * @param {object} opts
 */
export function reasonCounterfactual(removedCause, { maxDepth = 5 } = {}) {
  const chain = traceCausalChain(removedCause, { maxDepth, decayPerHop: 1.0 })

  if (chain.length === 0) {
    return {
      removed_cause: removedCause,
      affected_count: 0,
      affected_effects: [],
      narrative: `Não há efeitos conhecidos de "${removedCause}" no grafo causal. Sem dados para contrafactual.`,
    }
  }

  // Agrupa efeitos únicos com a menor profundidade (efeito mais direto)
  const effectMap = new Map()
  for (const link of chain) {
    const existing = effectMap.get(link.effect)
    if (!existing || link.depth < existing.depth) {
      effectMap.set(link.effect, {
        effect: link.effect,
        depth: link.depth,
        // quanto mais raso, maior o impacto se a causa for removida
        impact_if_removed: Math.round((1 - link.depth * 0.15) * link.link_confidence * 1000) / 1000,
      })
    }
  }

  const affected = [...effectMap.values()].sort((a, b) => b.impact_if_removed - a.impact_if_removed)

  const narrative = `Se "${removedCause}" não tivesse ocorrido, ${affected.length} efeito(s) seriam afetados. ` +
    `Mais diretos: ${affected.slice(0, 3).map(e => `"${e.effect}" (impacto ${e.impact_if_removed})`).join(', ')}.`

  return {
    removed_cause: removedCause,
    affected_count: affected.length,
    affected_effects: affected,
    chain,
    narrative,
  }
}
