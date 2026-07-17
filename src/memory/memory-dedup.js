/**
 * Memory Deduplication (U3) — deduplicação fuzzy com votação via WhatsApp.
 *
 * Processo:
 *   1. Agrupa memórias por similaridade de embedding (cosine > 0.85)
 *   2. Dentro de cada cluster, calcula distância Levenshtein normalizada
 *   3. Pares com distância < 0.35 → candidatos a duplicata
 *   4. Enfileira pergunta ao usuário via WhatsApp
 *   5. Voto do usuário (A/B/merge) → arquiva perdedora, booste vencedora
 */

import { getDb } from '../db/index.js'
import { sendWhatsApp } from '../gateway/evolution.js'
import { createLogger } from '../logger.js'
const log = createLogger('dedup')

/** Distância de Levenshtein normalizada (0=idêntico, 1=totalmente diferente) */
function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n / Math.max(1, n)
  if (n === 0) return m / Math.max(1, m)
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n] / Math.max(m, n)
}

/** Jaccard de tokens (pré-filtro barato, sem depender de embeddings/vec0) */
function jaccardTokens(a, b) {
  const tok = s => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 3))
  const sa = tok(a), sb = tok(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/**
 * Roda deduplicação: encontra pares candidatos e enfileira para votação.
 * Usa Jaccard de tokens como pré-filtro (barato) + Levenshtein para confirmar.
 * Não depende da extensão sqlite-vec (robusto em qualquer contexto).
 * @param {object} opts
 * @param {number} opts.jaccardThreshold overlap mínimo de tokens (default 0.5)
 * @param {number} opts.levenshteinThreshold distância máxima para candidato (default 0.35)
 * @param {number} opts.limit max memórias a analisar (default 200)
 */
export async function runDeduplication({ jaccardThreshold = 0.5, levenshteinThreshold = 0.35, limit = 200 } = {}) {
  const db = getDb()

  const memories = db.prepare(`
    SELECT id, content, confidence, created_at, category
    FROM memories
    WHERE archived = 0 AND type != 'raw'
    ORDER BY confidence DESC
    LIMIT ?
  `).all(limit)

  if (memories.length < 2) return { pairs: 0, queued: 0 }

  const pairs = []

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]
      const b = memories[j]

      // Passo 1: Jaccard de tokens (rápido, descarta pares óbvios)
      const jac = jaccardTokens(a.content, b.content)
      if (jac < jaccardThreshold) continue

      // Passo 2: Levenshtein (preciso para textos similares)
      const dist = levenshtein(a.content.slice(0, 300), b.content.slice(0, 300))
      if (dist > levenshteinThreshold) continue

      pairs.push({
        id_a: a.id, content_a: a.content, conf_a: a.confidence, ts_a: a.created_at,
        id_b: b.id, content_b: b.content, conf_b: b.confidence, ts_b: b.created_at,
        cosine: Math.round(jac * 1000) / 1000,  // reusa coluna cosine_sim p/ score jaccard
        levenshtein: Math.round(dist * 1000) / 1000,
      })
    }
  }

  // Remove pares já enfileirados
  let queued = 0
  const insertPair = db.prepare(`
    INSERT OR IGNORE INTO dedup_queue
      (id_a, content_a, id_b, content_b, cosine_sim, lev_distance)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  for (const p of pairs) {
    try {
      const r = insertPair.run(p.id_a, p.content_a, p.id_b, p.content_b, p.cosine, p.levenshtein)
      if (r.changes > 0) queued++
    } catch {}
  }

  log.info({ pairs: pairs.length, queued }, '[dedup] candidatos a duplicata encontrados')
  return { pairs: pairs.length, queued }
}

/**
 * Envia a próxima pergunta de deduplicação pendente via WhatsApp.
 */
export async function sendNextDedupQuestion() {
  const db = getDb()
  const owner = process.env.WHATSAPP_OWNER_JID
  if (!owner) return null

  const pair = db.prepare(`
    SELECT * FROM dedup_queue
    WHERE resolved = 0
    ORDER BY cosine_sim DESC
    LIMIT 1
  `).get()

  if (!pair) return null

  const snipA = pair.content_a.slice(0, 80).replace(/\n/g, ' ')
  const snipB = pair.content_b.slice(0, 80).replace(/\n/g, ' ')

  await sendWhatsApp(owner,
    `🔍 *Memórias duplicadas?* (sim=${pair.cosine_sim})\n\nA) "${snipA}..."\nB) "${snipB}..."\n\nResponda:\n• A — ficar com A\n• B — ficar com B\n• M — mesclar (guardar ambas)\n• X — não são duplicatas\n\n_(ID: ${pair.id}↗)_`
  ).catch(() => {})

  db.prepare(`UPDATE dedup_queue SET question_sent_at = unixepoch() WHERE id = ?`).run(pair.id)
  return pair
}

/**
 * Processa resposta do usuário à pergunta de dedup.
 * @param {string} queueId
 * @param {'A'|'B'|'M'|'X'} vote
 */
export function resolveDedupVote(queueId, vote) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const pair = db.prepare(`SELECT * FROM dedup_queue WHERE id = ?`).get(queueId)
  if (!pair) return { ok: false, error: 'par não encontrado' }

  const v = vote.toUpperCase()

  if (v === 'A') {
    db.prepare(`UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?`).run(now, pair.id_b)
    db.prepare(`UPDATE memories SET confidence = MIN(1.0, confidence * 1.2), updated_at = ? WHERE id = ?`).run(now, pair.id_a)
  } else if (v === 'B') {
    db.prepare(`UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?`).run(now, pair.id_a)
    db.prepare(`UPDATE memories SET confidence = MIN(1.0, confidence * 1.2), updated_at = ? WHERE id = ?`).run(now, pair.id_b)
  } else if (v === 'M') {
    // Mesclar: manter ambas, marcadas como "merged"
    for (const id of [pair.id_a, pair.id_b]) {
      try {
        const m = db.prepare(`SELECT metadata FROM memories WHERE id = ?`).get(id)
        const meta = JSON.parse(m?.metadata ?? '{}')
        meta.merged_pair = id === pair.id_a ? pair.id_b : pair.id_a
        db.prepare(`UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(meta), now, id)
      } catch {}
    }
  }
  // 'X' = não duplicata, apenas marca como resolvido

  db.prepare(`UPDATE dedup_queue SET resolved = 1, vote = ?, resolved_at = ? WHERE id = ?`).run(v, now, queueId)

  log.info({ queueId, vote: v }, '[dedup] voto processado')
  return { ok: true, vote: v }
}

/** Lista fila de dedup pendente */
export function listDedupQueue(limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT id, content_a, content_b, cosine_sim, lev_distance, question_sent_at
      FROM dedup_queue WHERE resolved = 0
      ORDER BY cosine_sim DESC LIMIT ?
    `).all(limit)
  } catch { return [] }
}
