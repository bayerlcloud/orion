import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { extractFacts, extractEntities } from './extraction.js'
import { generateEmbedding } from './embeddings.js'
import { saveVector, searchVectors } from './vector.js'
import { DECAY_RATES, CATEGORY_QUOTAS, HEBBIAN_DISTANCE } from './decay-config.js'
import { threatCheck } from './threat-check.js'
import { entityPhaseVector, phaseBundleVectors, phaseSimilarity } from './hrr-composer.js'
import { recordCoRetrieval, getSuggestedAssociates } from './co-retrieval.js'
import { addToWorkingMemory, getWorkingMemory } from './working-memory.js'
import { redact } from './redaction.js'
import { applyObservation, applyCrossSessionBonus } from './bayesian-updater.js'
import { indexMemoryEvents } from './temporal-index.js'
import { extractCausalLinks, hasCausalSignal } from './causal-graph.js'
export { retrieveByComposedEntities, probe, related, reason } from './hrr-composer.js'
export { applyObservation, getBayesHistory } from './bayesian-updater.js'
export { checkDrift, getRecentDrifts } from './drift-detector.js'
export { extractiveSummary, getCategorySummary, getNarrativeSummary } from './tiered-summarizer.js'
export { getMemoriesInPeriod, getChronologicalMemories, getTemporalIndexStats } from './temporal-index.js'
export { getNextResolutionQuestion, resolveContradiction, listPendingContradictions, getResolutionStats } from './contradiction-resolver.js'
export { saveCausalLink, getEffects, getCauses, listCausalLinks, traceCausalChain, reasonCounterfactual } from './causal-graph.js'
export { multiHopQuery } from './multi-hop-qa.js'
export { runDeduplication, sendNextDedupQuestion, resolveDedupVote, listDedupQueue } from './memory-dedup.js'
export { createSessionSnapshot, getMemoryStateAt, compareSnapshots, listSnapshotSessions, pruneOldSnapshots } from './memory-snapshots.js'

const RECENCY_LAMBDA = 0.0001  // decaimento exponencial
const MIN_TRUST = 0.15          // confiança mínima para aparecer no retrieval

// Consequence weights por categoria (salience scoring)
const CONSEQUENCE_WEIGHTS = {
  person: 1.0, decision: 0.9, user_pref: 0.8,
  project: 0.7, tool: 0.5, general: 0.3,
}

// ── Evento de escrita de memória ──────────────────────────────────────────────
const _writeListeners = []
export function onMemoryWrite(fn) { _writeListeners.push(fn) }
function emitMemoryWrite(event) {
  for (const fn of _writeListeners) { try { fn(event) } catch {} }
}

// ── MMR: Maximal Marginal Relevance — diversidade pós-retrieval ───────────────
// λ=0.7: 70% relevância + 30% diversidade (penaliza redundância temática)
function applyMMR(candidates, limit, lambda = 0.7) {
  if (candidates.length <= limit) return candidates
  const selected = []
  const remaining = [...candidates]
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0, bestMMR = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      let maxSim = 0
      if (selected.length > 0) {
        const cToks = new Set(String(c.content).toLowerCase().split(/\W+/).filter(t => t.length > 3))
        for (const s of selected) {
          const sToks = new Set(String(s.content).toLowerCase().split(/\W+/).filter(t => t.length > 3))
          let inter = 0
          for (const t of cToks) if (sToks.has(t)) inter++
          const union = cToks.size + sToks.size - inter
          const sim = union > 0 ? inter / union : 0
          if (sim > maxSim) maxSim = sim
        }
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim
      if (mmr > bestMMR) { bestMMR = mmr; bestIdx = i }
    }
    selected.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }
  return selected
}

function recencyScore(createdAt) {
  const ageSeconds = Math.floor(Date.now() / 1000) - createdAt
  return Math.exp(-RECENCY_LAMBDA * ageSeconds)
}

// Jaccard: token overlap como estágio intermediário de reranking
function jaccardSim(query, content, tags = '') {
  const tokenize = s => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 2))
  const q = tokenize(String(query))
  const c = tokenize(content + ' ' + String(tags ?? ''))
  if (q.size === 0 || c.size === 0) return 0
  let inter = 0
  for (const t of q) if (c.has(t)) inter++
  return inter / (q.size + c.size - inter)
}

// HRR content similarity: phase vectors de tokens de conteúdo (3° estágio de retrieval)
// Captura similaridade composicional além do overlap lexical (Jaccard)
function hrrContentSim(queryStr, factContent) {
  const tokenize = s => s.toLowerCase().split(/\W+/).filter(t => t.length > 3).slice(0, 12)
  const qToks = tokenize(String(queryStr))
  const fToks = tokenize(String(factContent))
  if (qToks.length === 0 || fToks.length === 0) return 0
  try {
    const qPhase = phaseBundleVectors(qToks.map(t => entityPhaseVector(t)))
    const fPhase = phaseBundleVectors(fToks.map(t => entityPhaseVector(t)))
    if (!qPhase || !fPhase) return 0
    return (phaseSimilarity(qPhase, fPhase) + 1) / 2  // normaliza [-1,1] → [0,1]
  } catch { return 0 }
}

// ── Salvar memória ────────────────────────────────────────────────────────────

export function saveMemory({ content, type = 'raw', source = 'unknown', confidence = 0.1, metadata = {}, tags = [], category = 'general', sourceChannel = null, sourceSessionId = null, sourceTool = null }) {
  // ── Redação de dados sensíveis (Round 4, item 1) ──────────────────────────
  const redacted = redact(String(content ?? ''))
  const safeContent = redacted.content
  if (redacted.changed) {
    metadata = { ...metadata, redacted_patterns: redacted.patterns }
  }

  // D. Threat detection: bloqueia injeção antes de persistir
  const threat = threatCheck(safeContent)
  if (!threat.safe) {
    const db = getDb()
    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO memories (id, type, content, source, confidence, metadata, tags, category, source_channel, source_session_id, source_tool)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'raw', `[BLOCKED: possível injeção] ${safeContent.slice(0, 80)}`, source, 0.01,
      JSON.stringify({ ...metadata, threat_pattern: threat.pattern, blocked: true }),
      JSON.stringify(['blocked', 'threat']), 'general', sourceChannel, sourceSessionId, sourceTool)
    return id
  }

  // ── Ajuste bayesiano inicial baseado na fonte (Round 4, item 6) ─────────────
  const sourceObs = sourceTool === 'correction-learning' ? 'correction_learning'
    : sourceTool === 'haiku-extraction' ? 'haiku_extraction'
    : sourceTool === 'background-review' ? 'background_review'
    : sourceTool === 'pre-compress' ? 'pre_compress'
    : null

  const db = getDb()
  const id = crypto.randomUUID()
  const result = db.prepare(`
    INSERT INTO memories (id, type, content, source, confidence, metadata, tags, category, source_channel, source_session_id, source_tool)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, safeContent, source, confidence, JSON.stringify(metadata), JSON.stringify(tags), category, sourceChannel, sourceSessionId, sourceTool)

  // Emite evento de escrita para subscribers externos
  emitMemoryWrite({ id, content: safeContent, type, category, confidence, source, sourceTool })

  // Gera embedding, memory bank e forgetting por interferência em background
  const rowid = result.lastInsertRowid
  setImmediate(async () => {
    try {
      const embedding = await generateEmbedding(safeContent)
      if (embedding) {
        // ── Gate hebbiano: fato quase idêntico já existe → REFORÇA em vez de
        // duplicar. Repetição é sinal de importância, não ruído. A linha nova é
        // arquivada com ponteiro pra canônica; nada mais roda pra ela.
        try {
          const dup = searchVectors(embedding, { limit: 2 })
            .find(v => v.id !== id && v.distance <= HEBBIAN_DISTANCE)
          if (dup) {
            const dbH = getDb()
            dbH.prepare(`
              UPDATE memories SET confidence = MIN(0.99, MAX(confidence, ?) + 0.05),
                access_count = access_count + 1, last_accessed = unixepoch(), updated_at = unixepoch()
              WHERE id = ?`).run(confidence, dup.id)
            dbH.prepare(`
              UPDATE memories SET archived = 1,
                metadata = json_set(COALESCE(metadata, '{}'), '$.merged_into', ?)
              WHERE id = ?`).run(dup.id, id)
            return
          }
        } catch {}
        saveVector(rowid, embedding)
      }
    } catch {}
    try { rebuildMemoryBank(category) } catch {}

    // ── Cota por categoria: teto estrutural — encheu, arquiva a de menor valor
    try {
      const dbQ = getDb()
      const cap = CATEGORY_QUOTAS[category] ?? CATEGORY_QUOTAS.default
      const n = dbQ.prepare(`SELECT COUNT(*) n FROM memories WHERE category = ? AND (archived = 0 OR archived IS NULL)`).get(category).n
      if (n > cap) {
        dbQ.prepare(`
          UPDATE memories SET archived = 1 WHERE id IN (
            SELECT id FROM memories WHERE category = ? AND (archived = 0 OR archived IS NULL)
            ORDER BY (
              confidence / (1.0 + (unixepoch() - COALESCE(last_accessed, created_at)) / 2592000.0)
              + 0.05 * MIN(access_count, 10)
            ) ASC
            LIMIT ?)`).run(category, n - cap)
      }
    } catch {}

    // ── Indexação temporal (Round 4, item 10) ────────────────────────────────
    try { indexMemoryEvents(id, safeContent, Math.floor(Date.now() / 1000)) } catch {}

    // ── Bayesian: aplica observação da fonte (Round 4, item 6) ───────────────
    if (sourceObs) {
      try { applyObservation(id, sourceObs) } catch {}
    }

    // ── Cross-session bonus (Round 4, item 6b) ────────────────────────────────
    if (sourceSessionId) {
      try { applyCrossSessionBonus(safeContent) } catch {} // eslint-disable-line no-unused-vars
    }

    // Forgetting por interferência: novo fato similar ligeiramente decai memórias antigas
    // (modelo de interferência proativa — novas memórias "competem" com anteriores)
    if (confidence >= 0.5) {
      try {
        const similar = retrieveMemories(content, { limit: 3 })
        const dbI = getDb()
        for (const s of similar) {
          if (s.id === id) continue
          const penalty = Math.min(0.025, (s.score ?? 0.1) * 0.03)
          dbI.prepare(`UPDATE memories SET confidence = MAX(0.05, confidence - ?), updated_at = unixepoch() WHERE id = ?`)
            .run(penalty, s.id)
        }
      } catch {}
    }
  })

  return id
}

export function saveRelation({ subject, relation, object, confidence = 0.8, source }) {
  const db = getDb()
  db.prepare(`
    INSERT INTO relations (subject, relation, object, confidence, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject, relation, object) DO UPDATE SET
      confidence = MAX(confidence, excluded.confidence),
      source = excluded.source
  `).run(subject, relation, object, confidence, source)
}

export function saveEntity({ name, type, description, confidence = 0.8 }) {
  const db = getDb()
  db.prepare(`
    INSERT INTO entities (name, type, description, confidence)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name, type) DO UPDATE SET
      description = COALESCE(excluded.description, description),
      confidence = MAX(confidence, excluded.confidence),
      updated_at = unixepoch()
  `).run(name, type, description ?? null, confidence)
}

// ── Retrieval híbrido: BM25 + recência ───────────────────────────────────────

export function retrieveMemories(query, { limit = 10, minConfidence = 0.1, sessionId = null } = {}) {
  if (!query) return []
  const db = getDb()

  // BM25 via FTS5
  const ftsRows = db.prepare(`
    SELECT m.id, m.content, m.type, m.confidence, m.created_at, m.access_count,
           m.tags, m.category, m.helpful_votes, m.unhelpful_votes,
           bm25(memories_fts) AS bm25_score
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.confidence >= ?
      AND m.archived = 0
      AND m.source NOT IN ('vault','claude_md','claude_mem')
    ORDER BY bm25_score
    LIMIT ?
  `).all(String(query).replace(/[^\w\s]/g, ' ').trim() || '""', minConfidence, limit * 2)

  // Recentes de alta confiança (fallback se FTS retornar pouco)
  // Docs ingeridos (vault/claude_md/claude_mem) ficam de fora da busca conversacional —
  // já chegam ao prompt pela camada de vault/CLAUDE.md; aqui só FATOS aprendidos.
  const recentRows = db.prepare(`
    SELECT id, content, type, confidence, created_at, access_count,
           tags, category, helpful_votes, unhelpful_votes, 0.0 AS bm25_score
    FROM memories
    WHERE confidence >= 0.5
      AND archived = 0
      AND source NOT IN ('vault','claude_md','claude_mem')
    ORDER BY last_accessed DESC, confidence DESC
    LIMIT ?
  `).all(Math.ceil(limit / 2))

  // Merge + score híbrido com trust multiplicativo
  const seen = new Set()
  const scored = []

  for (const row of [...ftsRows, ...recentRows]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)

    const bm25 = row.bm25_score ? Math.abs(row.bm25_score) : 0
    const bm25Norm = bm25 / (bm25 + 1)
    const recency = recencyScore(row.created_at)
    const agedays = (Math.floor(Date.now() / 1000) - (row.last_accessed ?? row.created_at)) / 86400
    const rate = DECAY_RATES[row.category] ?? DECAY_RATES.general
    const adjustedConf = row.confidence * Math.exp(-rate * Math.max(0, agedays))

    // min_trust: descarta memórias com confiança decaída abaixo do threshold
    if (adjustedConf < MIN_TRUST) continue

    const hv = row.helpful_votes ?? 0
    const uv = row.unhelpful_votes ?? 0
    const feedbackBoost = hv > 0 || uv > 0 ? (hv - uv * 2) / (hv + uv * 2 + 1) * 0.08 : 0
    const jaccard = jaccardSim(query, row.content, row.tags ?? '')
    const hrr = hrrContentSim(query, row.content)
    const consequence = CONSEQUENCE_WEIGHTS[row.category] ?? 0.3
    const accessNorm = Math.min(1, (row.access_count ?? 0) / 10)
    const salienceBonus = consequence * accessNorm * 0.06

    // Trust multiplicativo: relevância × confiança (memórias pouco confiáveis têm peso proporcional)
    const relevanceBase = 0.45 * bm25Norm + 0.16 * jaccard + 0.13 * hrr + 0.26 * recency
    const score = relevanceBase * adjustedConf + feedbackBoost + salienceBonus

    scored.push({ ...row, score })
  }

  scored.sort((a, b) => b.score - a.score)

  // MMR: diversifica os top results (evita retornar 5 memórias idênticas)
  const top = applyMMR(scored, limit)

  // Atualizar access_count e last_accessed
  if (top.length > 0) {
    const ids = top.map(r => `'${r.id}'`).join(',')
    db.exec(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed = unixepoch()
      WHERE id IN (${ids})
    `)
    // Registrar co-retrieval para future associações
    recordCoRetrieval(top.map(r => r.id))
    // Sugerir memórias associadas não incluídas
    const assocIds = getSuggestedAssociates(top.map(r => r.id))
    if (assocIds.length > 0) {
      const assocRows = assocIds.map(aid => db.prepare(`SELECT * FROM memories WHERE id = ? AND archived = 0`).get(aid)).filter(Boolean)
      for (const ar of assocRows) {
        if (!top.some(t => t.id === ar.id)) {
          top.push({ ...ar, score: 0.1, _associated: true })
        }
      }
    }
  }

  // ── U7: Memory Lottery — 5% das vezes injeta uma memória esquecida ──────────
  // Peso = confidence × sqrt(dias_sem_acesso). Superficia ideias antigas relevantes.
  if (Math.random() < 0.05 && top.length > 0) {
    try {
      const now = Math.floor(Date.now() / 1000)
      const topIds = new Set(top.map(t => t.id))
      const pool = db.prepare(`
        SELECT id, content, type, confidence, category, created_at, last_accessed, access_count
        FROM memories
        WHERE archived = 0 AND confidence >= 0.4
        ORDER BY last_accessed ASC
        LIMIT 60
      `).all().filter(m => !topIds.has(m.id))

      if (pool.length > 0) {
        const weighted = pool.map(m => {
          const daysSince = (now - (m.last_accessed ?? m.created_at)) / 86400
          return { m, w: m.confidence * Math.sqrt(Math.max(1, daysSince)) }
        })
        const totalW = weighted.reduce((s, x) => s + x.w, 0)
        let r = Math.random() * totalW
        for (const { m, w } of weighted) {
          r -= w
          if (r <= 0) {
            top.push({ ...m, score: 0.05, _lottery: true })
            break
          }
        }
      }
    } catch {}
  }

  // Working memory injection: fatos da sessão atual têm prioridade máxima
  if (sessionId) {
    const wmItems = getWorkingMemory(sessionId, query)
    const wmResults = wmItems.slice(0, 3).map(item => ({
      id: `wm-${Math.random().toString(36).slice(2)}`,
      content: item.content,
      type: 'working_memory',
      category: item.category,
      confidence: 1.0,
      score: 2.0,
      source: 'working_memory',
      access_count: 0,
      created_at: Math.floor(item.addedAt / 1000),
    }))
    return [...wmResults, ...top]
  }

  return top
}

// ── Memória proativa ─────────────────────────────────────────────────────────
// Retorna memórias altamente relevantes para surfaçar ANTES de agir

const PROACTIVE_SCORE_THRESHOLD = 0.62
const PROACTIVE_CONFIDENCE_MIN  = 0.45

export function getProactiveMemories(query, { limit = 3 } = {}) {
  const candidates = retrieveMemories(query, { limit: 15, minConfidence: PROACTIVE_CONFIDENCE_MIN })
  return candidates.filter(m => (m.score ?? 0) >= PROACTIVE_SCORE_THRESHOLD).slice(0, limit)
}

// ── Retrieval híbrido: BM25 + embeddings vetoriais ───────────────────────────

export async function retrieveHybrid(query, { limit = 8 } = {}) {
  // BM25 results (já existentes via retrieveMemories)
  const bm25 = retrieveMemories(query, { limit: limit * 2 })

  // Vector results
  let vectorResults = []
  try {
    const embedding = await generateEmbedding(query)
    if (embedding) {
      const raw = searchVectors(embedding, { limit: limit * 2 })
      // Normaliza distância para score 0-1 (menor distância = maior score)
      vectorResults = raw.map(r => ({
        ...r,
        // vec0 retorna L2; para vetores normalizados, cos = 1 - L2²/2 (exato)
        vectorScore: Math.max(0, 1 - (r.distance ** 2) / 2)
      }))
    }
  } catch {}

  // Merge: combina os dois conjuntos por id de memória
  const byId = new Map()

  for (const m of bm25) {
    byId.set(m.id, { ...m, bm25Score: m.score ?? 0, vectorScore: 0 })
  }
  for (const v of vectorResults) {
    if (byId.has(v.id)) {
      byId.get(v.id).vectorScore = v.vectorScore
    } else {
      // Só no vector search — busca no banco para pegar todos os campos
      // (exclui docs ingeridos: já entram pela camada de vault)
      const db = getDb()
      const mem = db.prepare(`SELECT * FROM memories WHERE id = ? AND archived = 0 AND source NOT IN ('vault','claude_md','claude_mem')`).get(v.id)
      if (mem) byId.set(v.id, { ...mem, bm25Score: 0, vectorScore: v.vectorScore })
    }
  }

  // Score híbrido com trust multiplicativo e filtro min_trust
  const recencyNow = Math.floor(Date.now() / 1000)
  const mergedRaw = [...byId.values()].map(m => {
    const recency = Math.exp(-(recencyNow - (m.last_accessed ?? m.created_at ?? 0)) / (7 * 86400))
    const agedays = (recencyNow - (m.last_accessed ?? m.created_at ?? recencyNow)) / 86400
    const rate = DECAY_RATES[m.category] ?? DECAY_RATES.general
    const adjustedConf = (m.confidence ?? 0.5) * Math.exp(-rate * Math.max(0, agedays))

    // min_trust: descarta entradas muito degradadas
    if (adjustedConf < MIN_TRUST) return null

    const hv = m.helpful_votes ?? 0
    const uv = m.unhelpful_votes ?? 0
    const feedbackBoost = hv > 0 || uv > 0 ? (hv - uv * 2) / (hv + uv * 2 + 1) * 0.06 : 0
    const jaccard = jaccardSim(query, m.content ?? '', m.tags ?? '')
    const hrr = hrrContentSim(query, m.content ?? '')
    const consequence = CONSEQUENCE_WEIGHTS[m.category] ?? 0.3
    const accessNorm = Math.min(1, (m.access_count ?? 0) / 10)
    const salienceBonus = consequence * accessNorm * 0.05

    // Trust multiplicativo: relevância × confiança
    const relevanceBase = 0.38 * (m.bm25Score ?? 0) + 0.26 * (m.vectorScore ?? 0) + 0.11 * jaccard + 0.10 * hrr + 0.15 * recency
    const hybrid = relevanceBase * adjustedConf + feedbackBoost + salienceBonus
    return { ...m, score: hybrid }
  }).filter(Boolean)

  mergedRaw.sort((a, b) => b.score - a.score)

  // MMR: evita retornar N variações do mesmo fato
  return applyMMR(mergedRaw, limit)
}

// ── Relações de uma entidade ──────────────────────────────────────────────────

export function getEntityContext(name) {
  const db = getDb()
  const asSubject = db.prepare(`
    SELECT relation, object, confidence FROM relations WHERE subject = ? ORDER BY confidence DESC LIMIT 20
  `).all(name)
  const asObject = db.prepare(`
    SELECT subject, relation, confidence FROM relations WHERE object = ? ORDER BY confidence DESC LIMIT 20
  `).all(name)
  return { asSubject, asObject }
}

// ── Melhoria 1: Feedback loop de confiança ───────────────────────────────────

export function feedbackMemory(id, isHelpful) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const mem = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id)
  if (!mem) return null

  let newConf
  if (isHelpful) {
    newConf = Math.min(0.95, mem.confidence + 0.15)
    db.prepare(`
      UPDATE memories
      SET helpful_votes = helpful_votes + 1,
          confidence = ?,
          updated_at = ?
      WHERE id = ?
    `).run(newConf, now, id)
  } else {
    newConf = Math.max(0.0, mem.confidence - 0.25)
    const corrected = newConf < 0.1 ? 1 : 0
    db.prepare(`
      UPDATE memories
      SET unhelpful_votes = unhelpful_votes + 1,
          confidence = ?,
          user_corrected = ?,
          archived = CASE WHEN ? = 1 THEN 1 ELSE archived END,
          updated_at = ?
      WHERE id = ?
    `).run(newConf, corrected, corrected, now, id)
  }

  return { id, newConfidence: newConf }
}

// ── Melhoria 2: Restore de memória arquivada ─────────────────────────────────

export function restoreMemory(id) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`UPDATE memories SET archived = 0, updated_at = ? WHERE id = ?`).run(now, id)
}

// ── Melhoria 3: Retrieval por tag / categoria ─────────────────────────────────

export function retrieveByTag(tag, limit = 20) {
  const db = getDb()
  // JSON array contains check via LIKE (compatível com SQLite sem extensões extras)
  return db.prepare(`
    SELECT * FROM memories
    WHERE tags LIKE ? AND archived = 0
    ORDER BY confidence DESC, last_accessed DESC
    LIMIT ?
  `).all(`%"${tag}"%`, limit)
}

export function retrieveByCategory(category, limit = 20) {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM memories
    WHERE category = ? AND archived = 0
    ORDER BY confidence DESC, last_accessed DESC
    LIMIT ?
  `).all(category, limit)
}

// ── Melhoria 4: Compositional reasoning (multi-entity retrieval) ──────────────

export function retrieveForEntities(entityNames, limit = 10) {
  if (!entityNames || entityNames.length === 0) return []
  const db = getDb()

  const scoreMap = new Map()

  for (const name of entityNames) {
    const safeName = name.replace(/[^\wà-ú\s]/gi, ' ').trim()
    if (!safeName) continue

    let rows = []
    try {
      rows = db.prepare(`
        SELECT m.id, m.content, m.type, m.confidence, m.created_at, m.access_count,
               m.tags, m.category, bm25(memories_fts) AS bm25_score
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND m.archived = 0
        ORDER BY bm25_score
        LIMIT ?
      `).all(safeName, limit * 3)
    } catch { continue }

    for (const row of rows) {
      if (!scoreMap.has(row.id)) {
        scoreMap.set(row.id, { ...row, mentions: 0, base_score: 0 })
      }
      const entry = scoreMap.get(row.id)
      entry.mentions += 1
      const bm25 = row.bm25_score ? Math.abs(row.bm25_score) : 0
      const bm25Norm = bm25 / (bm25 + 1)
      entry.base_score = Math.max(entry.base_score, bm25Norm)
    }
  }

  // Score composto: base × (1 + 0.3 × mentions)
  const results = [...scoreMap.values()].map(m => ({
    ...m,
    score: m.base_score * (1 + 0.3 * m.mentions)
  }))

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

// ── Melhoria 5: Memory banks por categoria ────────────────────────────────────

export function rebuildMemoryBank(category) {
  const db = getDb()
  const top = db.prepare(`
    SELECT id, content, confidence FROM memories
    WHERE category = ? AND archived = 0
    ORDER BY confidence DESC
    LIMIT 5
  `).all(category)

  const count = db.prepare(`
    SELECT COUNT(*) AS c FROM memories WHERE category = ? AND archived = 0
  `).get(category).c

  db.prepare(`
    INSERT INTO memory_banks (category, sample_count, top_memories, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(category) DO UPDATE SET
      sample_count = excluded.sample_count,
      top_memories = excluded.top_memories,
      updated_at   = excluded.updated_at
  `).run(category, count, JSON.stringify(top))
}

// ── Melhoria 7: Backfill de embeddings ───────────────────────────────────────

export async function backfillEmbeddings({ batch = 100, maxBatches = 20 } = {}) {
  const db = getDb()
  let processed = 0
  for (let b = 0; b < maxBatches; b++) {
    const rows = db.prepare(`
      SELECT m.id, m.content, m.rowid AS mrowid
      FROM memories m
      LEFT JOIN vec_memories v ON m.rowid = v.memory_rowid
      WHERE v.memory_rowid IS NULL AND (m.archived = 0 OR m.archived IS NULL)
      LIMIT ?
    `).all(batch)
    if (!rows.length) break
    for (const row of rows) {
      try {
        const embedding = await generateEmbedding(row.content)
        if (embedding) {
          saveVector(row.mrowid, embedding)
          processed++
        }
      } catch {}
    }
    if (rows.length < batch) break
  }
  if (processed > 0) {
    console.log(`[memory] backfill: ${processed} embeddings gerados`)
  }
  return processed
}

// ── Extração Haiku — fatos semânticos reais por troca ────────────────────────

async function extractWithHaiku(userMessage, assistantResponse, source, sessionId = null) {
  const prompt = `Analise esta conversa e extraia APENAS fatos concretos sobre o usuário (Danilo) — preferências, decisões, projetos, pessoas, animais, ferramentas que usa.

Conversa:
USER: ${userMessage.slice(0, 500)}
ASSISTANT: ${assistantResponse.slice(0, 500)}

Regras:
- Retorne 0 a 3 fatos, um por linha
- Formato de cada linha: CATEGORIA|TAGS|fato
  - CATEGORIA: uma de: general, user_pref, project, tool, person, decision
  - TAGS: até 3 tags separadas por vírgula (ou vazio)
  - Exemplo: "user_pref|typescript,linguagem|Danilo prefere TypeScript a JavaScript"
- Se NÃO houver fato relevante, retorne: NENHUM
- Não invente, não repita o óbvio

Fatos:`

  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000, env: { ...process.env, CLAUDE_CODE_DISABLE_MCP: '1' } })  // extração é só texto → sem MCPs (bem mais rápido/leve)
    const parsed = JSON.parse(result.stdout)
    const text = (parsed.result ?? parsed.content ?? '').trim()
    if (!text || text.toUpperCase() === 'NENHUM') return

    const lines = text.split('\n').map(l => l.replace(/^[-•\d.]+\s*/, '').trim()).filter(l => l.length > 8)
    for (const line of lines.slice(0, 3)) {
      // Tenta parsear formato CATEGORIA|TAGS|fato
      const parts = line.split('|')
      let category = 'general'
      let tags = []
      let content = line

      if (parts.length === 3) {
        const validCategories = ['general', 'user_pref', 'project', 'tool', 'person', 'decision']
        if (validCategories.includes(parts[0].trim())) {
          category = parts[0].trim()
          tags = parts[1].trim() ? parts[1].trim().split(',').map(t => t.trim()).filter(Boolean) : []
          content = parts[2].trim()
        }
      }

      if (content.length > 8) {
        saveMemory({ content, type: 'episodic', source, confidence: 0.65, tags, category, sourceTool: 'haiku-extraction', sourceSessionId: sessionId })
        // Adiciona à working memory da sessão — disponível imediatamente
        if (sessionId) addToWorkingMemory(sessionId, content, { category, source: 'haiku-extraction' })
      }
    }
  } catch {}
}

// ── Extração assíncrona (chamada após cada resposta) ──────────────────────────

export async function processExchange({ userMessage, assistantResponse, source, sessionId }) {
  setImmediate(async () => {
    try {
      // Extração de fatos via regex (rápida, sem LLM)
      const facts = extractFacts(`User: ${userMessage}\nAssistant: ${assistantResponse}`)
      for (const fact of facts) {
        const id = saveMemory({ content: fact, type: 'episodic', source, confidence: 0.5 })
        // Adiciona à working memory da sessão atual (acesso imediato antes de persistir)
        if (sessionId) addToWorkingMemory(sessionId, fact, { category: 'general', source: 'regex-extraction' })
      }

      // Extração de entidades e relações
      const { entities, relations } = extractEntities(`${userMessage} ${assistantResponse}`)
      for (const e of entities) saveEntity({ ...e, source })
      for (const r of relations) saveRelation({ ...r, source })

      // Extração semântica via Haiku (mais profunda, assíncrona) — a ÚNICA chamada
      // LLM por turno. Removidos backgroundReview (2º Haiku) e extração causal (3º
      // Haiku) — eram enxame de fundo que não melhorava a resposta.
      if (userMessage.trim().length > 20 && assistantResponse.trim().length > 20) {
        extractWithHaiku(userMessage, assistantResponse, source, sessionId).catch(() => {})
      }
    } catch (err) {
      console.error('[memory] Erro na extração:', err.message)
    }
  })

  // Pre-warm: retrieval assíncrono da resposta do assistente para o próximo turno
  // Aquece o cache de embeddings e sugere memórias relevantes para continuar a conversa
  setImmediate(async () => {
    try {
      await retrieveHybrid(assistantResponse.slice(0, 200), { limit: 4 })
    } catch {}
  })
}

// ── Forgetting schedule (SM-2 spaced repetition) ─────────────────────────────
// quality: 0-5 (passado da phase5 self-audit ou do access recente)
// quality >= 3 → ampliar intervalo; quality < 3 → resetar para 1d

export function scheduleNextReview(memoryId, quality = 4) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  let m
  try {
    m = db.prepare('SELECT review_interval_days, review_ease FROM memories WHERE id = ?').get(memoryId)
  } catch { return }
  if (!m) return

  const interval = m.review_interval_days ?? 1
  const ease = m.review_ease ?? 2.5

  let newInterval, newEase
  if (quality >= 3) {
    newInterval = interval <= 1 ? 3 : interval <= 3 ? 8 : Math.round(interval * ease)
    // SM-2 ease adjustment
    newEase = Math.max(1.3, ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  } else {
    newInterval = 1
    newEase = Math.max(1.3, ease - 0.2)
  }

  const nextReviewAt = now + newInterval * 86400
  try {
    db.prepare(`
      UPDATE memories SET next_review_at = ?, review_interval_days = ?, review_ease = ?, updated_at = ?
      WHERE id = ?
    `).run(nextReviewAt, newInterval, newEase, now, memoryId)
  } catch {}
}

// ── Concept drift: snapshot de versão anterior antes de atualizar ─────────────

export function snapshotMemoryVersion(memoryId, reason = 'update') {
  const db = getDb()
  const m = db.prepare('SELECT content, confidence, version_count FROM memories WHERE id = ?').get(memoryId)
  if (!m) return

  try {
    db.prepare(`
      INSERT INTO fact_versions (memory_id, content, confidence, reason)
      VALUES (?, ?, ?, ?)
    `).run(memoryId, m.content, m.confidence, reason)

    db.prepare(`
      UPDATE memories SET version_count = COALESCE(version_count, 1) + 1, updated_at = unixepoch()
      WHERE id = ?
    `).run(memoryId)
  } catch {}
}
