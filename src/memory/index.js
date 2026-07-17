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
import { extractCausalLinks } from './causal-graph.js'
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

const RECENCY_LAMBDA = 0.0001
const MIN_TRUST = 0.15

const CONSEQUENCE_WEIGHTS = { person: 1.0, decision: 0.9, user_pref: 0.8, project: 0.7, tool: 0.5, general: 0.3 }

const _writeListeners = []
export function onMemoryWrite(fn) { _writeListeners.push(fn) }
function emitMemoryWrite(event) { for (const fn of _writeListeners) { try { fn(event) } catch {} } }

function applyMMR(candidates, limit, lambda = 0.7) {
  if (candidates.length <= limit) return candidates
  const selected = [], remaining = [...candidates]
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0, bestMMR = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      let maxSim = 0
      if (selected.length > 0) {
        const cToks = new Set(String(c.content).toLowerCase().split(/\W+/).filter(t => t.length > 3))
        for (const s of selected) {
          const sToks = new Set(String(s.content).toLowerCase().split(/\W+/).filter(t => t.length > 3))
          let inter = 0; for (const t of cToks) if (sToks.has(t)) inter++
          const sim = (cToks.size + sToks.size - inter) > 0 ? inter / (cToks.size + sToks.size - inter) : 0
          if (sim > maxSim) maxSim = sim
        }
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim
      if (mmr > bestMMR) { bestMMR = mmr; bestIdx = i }
    }
    selected.push(remaining[bestIdx]); remaining.splice(bestIdx, 1)
  }
  return selected
}

function recencyScore(createdAt) { return Math.exp(-RECENCY_LAMBDA * (Math.floor(Date.now() / 1000) - createdAt)) }

function jaccardSim(query, content, tags = '') {
  const tokenize = s => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 2))
  const q = tokenize(String(query)), c = tokenize(content + ' ' + String(tags ?? ''))
  if (!q.size || !c.size) return 0
  let inter = 0; for (const t of q) if (c.has(t)) inter++
  return inter / (q.size + c.size - inter)
}

function hrrContentSim(queryStr, factContent) {
  const tokenize = s => s.toLowerCase().split(/\W+/).filter(t => t.length > 3).slice(0, 12)
  const qToks = tokenize(String(queryStr)), fToks = tokenize(String(factContent))
  if (!qToks.length || !fToks.length) return 0
  try {
    const qPhase = phaseBundleVectors(qToks.map(t => entityPhaseVector(t)))
    const fPhase = phaseBundleVectors(fToks.map(t => entityPhaseVector(t)))
    return (!qPhase || !fPhase) ? 0 : (phaseSimilarity(qPhase, fPhase) + 1) / 2
  } catch { return 0 }
}

export function saveMemory({ content, type = 'raw', source = 'unknown', confidence = 0.1, metadata = {}, tags = [], category = 'general', sourceChannel = null, sourceSessionId = null, sourceTool = null }) {
  const redacted = redact(String(content ?? ''))
  const safeContent = redacted.content
  if (redacted.changed) metadata = { ...metadata, redacted_patterns: redacted.patterns }

  const threat = threatCheck(safeContent)
  if (!threat.safe) {
    const db = getDb(), id = crypto.randomUUID()
    db.prepare(`INSERT INTO memories (id, type, content, source, confidence, metadata, tags, category, source_channel, source_session_id, source_tool) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'raw', `[BLOCKED] ${safeContent.slice(0, 80)}`, source, 0.01, JSON.stringify({ ...metadata, threat_pattern: threat.pattern, blocked: true }), JSON.stringify(['blocked', 'threat']), 'general', sourceChannel, sourceSessionId, sourceTool)
    return id
  }

  const sourceObs = { 'correction-learning': 'correction_learning', 'haiku-extraction': 'haiku_extraction', 'background-review': 'background_review', 'pre-compress': 'pre_compress' }[sourceTool] ?? null

  const db = getDb(), id = crypto.randomUUID()
  const result = db.prepare(`INSERT INTO memories (id, type, content, source, confidence, metadata, tags, category, source_channel, source_session_id, source_tool) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, type, safeContent, source, confidence, JSON.stringify(metadata), JSON.stringify(tags), category, sourceChannel, sourceSessionId, sourceTool)

  emitMemoryWrite({ id, content: safeContent, type, category, confidence, source, sourceTool })

  const rowid = result.lastInsertRowid
  setImmediate(async () => {
    try {
      const embedding = await generateEmbedding(safeContent)
      if (embedding) {
        try {
          const dup = searchVectors(embedding, { limit: 2 }).find(v => v.id !== id && v.distance <= HEBBIAN_DISTANCE)
          if (dup) {
            const dbH = getDb()
            dbH.prepare(`UPDATE memories SET confidence = MIN(0.99, MAX(confidence, ?) + 0.05), access_count = access_count + 1, last_accessed = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(confidence, dup.id)
            dbH.prepare(`UPDATE memories SET archived = 1, metadata = json_set(COALESCE(metadata, '{}'), '$.merged_into', ?) WHERE id = ?`).run(dup.id, id)
            return
          }
        } catch {}
        saveVector(rowid, embedding)
      }
    } catch {}
    try { rebuildMemoryBank(category) } catch {}
    try {
      const dbQ = getDb()
      const cap = CATEGORY_QUOTAS[category] ?? CATEGORY_QUOTAS.default
      const n = dbQ.prepare(`SELECT COUNT(*) n FROM memories WHERE category = ? AND (archived = 0 OR archived IS NULL)`).get(category).n
      if (n > cap) dbQ.prepare(`UPDATE memories SET archived = 1 WHERE id IN (SELECT id FROM memories WHERE category = ? AND (archived = 0 OR archived IS NULL) ORDER BY (confidence / (1.0 + (unixepoch() - COALESCE(last_accessed, created_at)) / 2592000.0) + 0.05 * MIN(access_count, 10)) ASC LIMIT ?)`).run(category, n - cap)
    } catch {}
    try { indexMemoryEvents(id, safeContent, Math.floor(Date.now() / 1000)) } catch {}
    if (sourceObs) { try { applyObservation(id, sourceObs) } catch {} }
    if (sourceSessionId) { try { applyCrossSessionBonus(safeContent) } catch {} }
    if (confidence >= 0.5) {
      try {
        const similar = retrieveMemories(content, { limit: 3 })
        const dbI = getDb()
        for (const s of similar) {
          if (s.id === id) continue
          dbI.prepare(`UPDATE memories SET confidence = MAX(0.05, confidence - ?), updated_at = unixepoch() WHERE id = ?`).run(Math.min(0.025, (s.score ?? 0.1) * 0.03), s.id)
        }
      } catch {}
    }
  })
  return id
}

export function saveRelation({ subject, relation, object, confidence = 0.8, source }) {
  getDb().prepare(`INSERT INTO relations (subject, relation, object, confidence, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject, relation, object) DO UPDATE SET confidence = MAX(confidence, excluded.confidence), source = excluded.source`).run(subject, relation, object, confidence, source)
}

export function saveEntity({ name, type, description, confidence = 0.8 }) {
  getDb().prepare(`INSERT INTO entities (name, type, description, confidence) VALUES (?, ?, ?, ?) ON CONFLICT(name, type) DO UPDATE SET description = COALESCE(excluded.description, description), confidence = MAX(confidence, excluded.confidence), updated_at = unixepoch()`).run(name, type, description ?? null, confidence)
}

export function retrieveMemories(query, { limit = 10, minConfidence = 0.1, sessionId = null } = {}) {
  if (!query) return []
  const db = getDb()
  const ftsRows = db.prepare(`SELECT m.id, m.content, m.type, m.confidence, m.created_at, m.access_count, m.tags, m.category, m.helpful_votes, m.unhelpful_votes, bm25(memories_fts) AS bm25_score FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? AND m.confidence >= ? AND m.archived = 0 AND m.source NOT IN ('vault','claude_md','claude_mem') ORDER BY bm25_score LIMIT ?`).all(String(query).replace(/[^\w\s]/g, ' ').trim() || '""', minConfidence, limit * 2)
  const recentRows = db.prepare(`SELECT id, content, type, confidence, created_at, access_count, tags, category, helpful_votes, unhelpful_votes, 0.0 AS bm25_score FROM memories WHERE confidence >= 0.5 AND archived = 0 AND source NOT IN ('vault','claude_md','claude_mem') ORDER BY last_accessed DESC, confidence DESC LIMIT ?`).all(Math.ceil(limit / 2))
  const seen = new Set(), scored = []
  for (const row of [...ftsRows, ...recentRows]) {
    if (seen.has(row.id)) continue; seen.add(row.id)
    const bm25Norm = (Math.abs(row.bm25_score || 0)) / (Math.abs(row.bm25_score || 0) + 1)
    const recency = recencyScore(row.created_at)
    const agedays = (Math.floor(Date.now() / 1000) - (row.last_accessed ?? row.created_at)) / 86400
    const adjustedConf = row.confidence * Math.exp(-(DECAY_RATES[row.category] ?? DECAY_RATES.general) * Math.max(0, agedays))
    if (adjustedConf < MIN_TRUST) continue
    const hv = row.helpful_votes ?? 0, uv = row.unhelpful_votes ?? 0
    const feedbackBoost = (hv > 0 || uv > 0) ? (hv - uv * 2) / (hv + uv * 2 + 1) * 0.08 : 0
    const jaccard = jaccardSim(query, row.content, row.tags ?? '')
    const hrr = hrrContentSim(query, row.content)
    const salienceBonus = (CONSEQUENCE_WEIGHTS[row.category] ?? 0.3) * Math.min(1, (row.access_count ?? 0) / 10) * 0.06
    scored.push({ ...row, score: (0.45 * bm25Norm + 0.16 * jaccard + 0.13 * hrr + 0.26 * recency) * adjustedConf + feedbackBoost + salienceBonus })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = applyMMR(scored, limit)
  if (top.length > 0) {
    db.exec(`UPDATE memories SET access_count = access_count + 1, last_accessed = unixepoch() WHERE id IN (${top.map(r => `'${r.id}'`).join(',')})`)
    recordCoRetrieval(top.map(r => r.id))
    const assocIds = getSuggestedAssociates(top.map(r => r.id))
    if (assocIds.length) {
      const assocRows = assocIds.map(aid => db.prepare(`SELECT * FROM memories WHERE id = ? AND archived = 0`).get(aid)).filter(Boolean)
      for (const ar of assocRows) { if (!top.some(t => t.id === ar.id)) top.push({ ...ar, score: 0.1, _associated: true }) }
    }
  }
  if (Math.random() < 0.05 && top.length > 0) {
    try {
      const now = Math.floor(Date.now() / 1000), topIds = new Set(top.map(t => t.id))
      const pool = db.prepare(`SELECT id, content, type, confidence, category, created_at, last_accessed, access_count FROM memories WHERE archived = 0 AND confidence >= 0.4 ORDER BY last_accessed ASC LIMIT 60`).all().filter(m => !topIds.has(m.id))
      if (pool.length) {
        const weighted = pool.map(m => ({ m, w: m.confidence * Math.sqrt(Math.max(1, (now - (m.last_accessed ?? m.created_at)) / 86400)) }))
        const totalW = weighted.reduce((s, x) => s + x.w, 0)
        let r = Math.random() * totalW
        for (const { m, w } of weighted) { r -= w; if (r <= 0) { top.push({ ...m, score: 0.05, _lottery: true }); break } }
      }
    } catch {}
  }
  if (sessionId) {
    const wmItems = getWorkingMemory(sessionId, query)
    return [...wmItems.slice(0, 3).map(item => ({ id: `wm-${Math.random().toString(36).slice(2)}`, content: item.content, type: 'working_memory', category: item.category, confidence: 1.0, score: 2.0, source: 'working_memory', access_count: 0, created_at: Math.floor(item.addedAt / 1000) })), ...top]
  }
  return top
}

export function getProactiveMemories(query, { limit = 3 } = {}) {
  return retrieveMemories(query, { limit: 15, minConfidence: 0.45 }).filter(m => (m.score ?? 0) >= 0.62).slice(0, limit)
}

export async function retrieveHybrid(query, { limit = 8 } = {}) {
  const bm25 = retrieveMemories(query, { limit: limit * 2 })
  let vectorResults = []
  try {
    const embedding = await generateEmbedding(query)
    if (embedding) {
      const raw = searchVectors(embedding, { limit: limit * 2 })
      vectorResults = raw.map(r => ({ ...r, vectorScore: Math.max(0, 1 - (r.distance ** 2) / 2) }))
    }
  } catch {}
  const byId = new Map()
  for (const m of bm25) byId.set(m.id, { ...m, bm25Score: m.score ?? 0, vectorScore: 0 })
  for (const v of vectorResults) {
    if (byId.has(v.id)) byId.get(v.id).vectorScore = v.vectorScore
    else {
      const mem = getDb().prepare(`SELECT * FROM memories WHERE id = ? AND archived = 0 AND source NOT IN ('vault','claude_md','claude_mem')`).get(v.id)
      if (mem) byId.set(v.id, { ...mem, bm25Score: 0, vectorScore: v.vectorScore })
    }
  }
  const recencyNow = Math.floor(Date.now() / 1000)
  const mergedRaw = [...byId.values()].map(m => {
    const recency = Math.exp(-(recencyNow - (m.last_accessed ?? m.created_at ?? 0)) / (7 * 86400))
    const agedays = (recencyNow - (m.last_accessed ?? m.created_at ?? recencyNow)) / 86400
    const adjustedConf = (m.confidence ?? 0.5) * Math.exp(-(DECAY_RATES[m.category] ?? DECAY_RATES.general) * Math.max(0, agedays))
    if (adjustedConf < MIN_TRUST) return null
    const hv = m.helpful_votes ?? 0, uv = m.unhelpful_votes ?? 0
    const feedbackBoost = (hv > 0 || uv > 0) ? (hv - uv * 2) / (hv + uv * 2 + 1) * 0.06 : 0
    const jaccard = jaccardSim(query, m.content ?? '', m.tags ?? '')
    const hrr = hrrContentSim(query, m.content ?? '')
    const salienceBonus = (CONSEQUENCE_WEIGHTS[m.category] ?? 0.3) * Math.min(1, (m.access_count ?? 0) / 10) * 0.05
    return { ...m, score: (0.38 * (m.bm25Score ?? 0) + 0.26 * (m.vectorScore ?? 0) + 0.11 * jaccard + 0.10 * hrr + 0.15 * recency) * adjustedConf + feedbackBoost + salienceBonus }
  }).filter(Boolean)
  mergedRaw.sort((a, b) => b.score - a.score)
  return applyMMR(mergedRaw, limit)
}

export function getEntityContext(name) {
  const db = getDb()
  return { asSubject: db.prepare(`SELECT relation, object, confidence FROM relations WHERE subject = ? ORDER BY confidence DESC LIMIT 20`).all(name), asObject: db.prepare(`SELECT subject, relation, confidence FROM relations WHERE object = ? ORDER BY confidence DESC LIMIT 20`).all(name) }
}

export function feedbackMemory(id, isHelpful) {
  const db = getDb(), now = Math.floor(Date.now() / 1000)
  const mem = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id)
  if (!mem) return null
  let newConf
  if (isHelpful) {
    newConf = Math.min(0.95, mem.confidence + 0.15)
    db.prepare(`UPDATE memories SET helpful_votes = helpful_votes + 1, confidence = ?, updated_at = ? WHERE id = ?`).run(newConf, now, id)
  } else {
    newConf = Math.max(0.0, mem.confidence - 0.25)
    const corrected = newConf < 0.1 ? 1 : 0
    db.prepare(`UPDATE memories SET unhelpful_votes = unhelpful_votes + 1, confidence = ?, user_corrected = ?, archived = CASE WHEN ? = 1 THEN 1 ELSE archived END, updated_at = ? WHERE id = ?`).run(newConf, corrected, corrected, now, id)
  }
  return { id, newConfidence: newConf }
}

export function restoreMemory(id) { getDb().prepare(`UPDATE memories SET archived = 0, updated_at = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), id) }
export function retrieveByTag(tag, limit = 20) { return getDb().prepare(`SELECT * FROM memories WHERE tags LIKE ? AND archived = 0 ORDER BY confidence DESC, last_accessed DESC LIMIT ?`).all(`%"${tag}"%`, limit) }
export function retrieveByCategory(category, limit = 20) { return getDb().prepare(`SELECT * FROM memories WHERE category = ? AND archived = 0 ORDER BY confidence DESC, last_accessed DESC LIMIT ?`).all(category, limit) }

export function retrieveForEntities(entityNames, limit = 10) {
  if (!entityNames?.length) return []
  const db = getDb(), scoreMap = new Map()
  for (const name of entityNames) {
    const safeName = name.replace(/[^\wà-ú\s]/gi, ' ').trim()
    if (!safeName) continue
    let rows = []
    try { rows = db.prepare(`SELECT m.id, m.content, m.type, m.confidence, m.created_at, m.access_count, m.tags, m.category, bm25(memories_fts) AS bm25_score FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? AND m.archived = 0 ORDER BY bm25_score LIMIT ?`).all(safeName, limit * 3) } catch { continue }
    for (const row of rows) {
      if (!scoreMap.has(row.id)) scoreMap.set(row.id, { ...row, mentions: 0, base_score: 0 })
      const entry = scoreMap.get(row.id)
      entry.mentions += 1
      const bm25 = Math.abs(row.bm25_score || 0)
      entry.base_score = Math.max(entry.base_score, bm25 / (bm25 + 1))
    }
  }
  return [...scoreMap.values()].map(m => ({ ...m, score: m.base_score * (1 + 0.3 * m.mentions) })).sort((a, b) => b.score - a.score).slice(0, limit)
}

export function rebuildMemoryBank(category) {
  const db = getDb()
  const top = db.prepare(`SELECT id, content, confidence FROM memories WHERE category = ? AND archived = 0 ORDER BY confidence DESC LIMIT 5`).all(category)
  const count = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE category = ? AND archived = 0`).get(category).c
  db.prepare(`INSERT INTO memory_banks (category, sample_count, top_memories, updated_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(category) DO UPDATE SET sample_count = excluded.sample_count, top_memories = excluded.top_memories, updated_at = excluded.updated_at`).run(category, count, JSON.stringify(top))
}

export async function backfillEmbeddings({ batch = 100, maxBatches = 20 } = {}) {
  const db = getDb(); let processed = 0
  for (let b = 0; b < maxBatches; b++) {
    const rows = db.prepare(`SELECT m.id, m.content, m.rowid AS mrowid FROM memories m LEFT JOIN vec_memories v ON m.rowid = v.memory_rowid WHERE v.memory_rowid IS NULL AND (m.archived = 0 OR m.archived IS NULL) LIMIT ?`).all(batch)
    if (!rows.length) break
    for (const row of rows) { try { const emb = await generateEmbedding(row.content); if (emb) { saveVector(row.mrowid, emb); processed++ } } catch {} }
    if (rows.length < batch) break
  }
  if (processed > 0) console.log(`[memory] backfill: ${processed} embeddings gerados`)
  return processed
}

async function extractWithHaiku(userMessage, assistantResponse, source, sessionId = null) {
  const ownerName = process.env.OWNER_DISPLAY_NAME || 'o usuário'
  const prompt = `Analise esta conversa e extraia APENAS fatos concretos sobre ${ownerName} — preferências, decisões, projetos, ferramentas que usa.\n\nConversa:\nUSER: ${userMessage.slice(0, 500)}\nASSISTANT: ${assistantResponse.slice(0, 500)}\n\nRegras:\n- Retorne 0 a 3 fatos, um por linha\n- Formato: CATEGORIA|TAGS|fato (categorias: general, user_pref, project, tool, person, decision)\n- Se não houver fato relevante, retorne: NENHUM\n\nFatos:`
  try {
    const result = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'], { timeout: 30_000, env: { ...process.env, CLAUDE_CODE_DISABLE_MCP: '1' } })
    const text = (JSON.parse(result.stdout).result ?? JSON.parse(result.stdout).content ?? '').trim()
    if (!text || text.toUpperCase() === 'NENHUM') return
    for (const line of text.split('\n').map(l => l.replace(/^[-•\d.]+\s*/, '').trim()).filter(l => l.length > 8).slice(0, 3)) {
      const parts = line.split('|')
      let category = 'general', tags = [], content = line
      if (parts.length === 3 && ['general', 'user_pref', 'project', 'tool', 'person', 'decision'].includes(parts[0].trim())) {
        category = parts[0].trim(); tags = parts[1].trim() ? parts[1].split(',').map(t => t.trim()).filter(Boolean) : []; content = parts[2].trim()
      }
      if (content.length > 8) {
        saveMemory({ content, type: 'episodic', source, confidence: 0.65, tags, category, sourceTool: 'haiku-extraction', sourceSessionId: sessionId })
        if (sessionId) addToWorkingMemory(sessionId, content, { category, source: 'haiku-extraction' })
      }
    }
  } catch {}
}

export async function processExchange({ userMessage, assistantResponse, source, sessionId }) {
  setImmediate(async () => {
    try {
      const facts = extractFacts(`User: ${userMessage}\nAssistant: ${assistantResponse}`)
      for (const fact of facts) { saveMemory({ content: fact, type: 'episodic', source, confidence: 0.5 }); if (sessionId) addToWorkingMemory(sessionId, fact, { category: 'general', source: 'regex-extraction' }) }
      const { entities, relations } = extractEntities(`${userMessage} ${assistantResponse}`)
      for (const e of entities) saveEntity({ ...e, source })
      for (const r of relations) saveRelation({ ...r, source })
      if (userMessage.trim().length > 20 && assistantResponse.trim().length > 20) extractWithHaiku(userMessage, assistantResponse, source, sessionId).catch(() => {})
    } catch (err) { console.error('[memory] Erro na extração:', err.message) }
  })
  setImmediate(async () => { try { await retrieveHybrid(assistantResponse.slice(0, 200), { limit: 4 }) } catch {} })
}

export function scheduleNextReview(memoryId, quality = 4) {
  const db = getDb(), now = Math.floor(Date.now() / 1000)
  let m; try { m = db.prepare('SELECT review_interval_days, review_ease FROM memories WHERE id = ?').get(memoryId) } catch { return }
  if (!m) return
  const interval = m.review_interval_days ?? 1, ease = m.review_ease ?? 2.5
  let newInterval, newEase
  if (quality >= 3) { newInterval = interval <= 1 ? 3 : interval <= 3 ? 8 : Math.round(interval * ease); newEase = Math.max(1.3, ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)) }
  else { newInterval = 1; newEase = Math.max(1.3, ease - 0.2) }
  try { db.prepare(`UPDATE memories SET next_review_at = ?, review_interval_days = ?, review_ease = ?, updated_at = ? WHERE id = ?`).run(now + newInterval * 86400, newInterval, newEase, now, memoryId) } catch {}
}

export function snapshotMemoryVersion(memoryId, reason = 'update') {
  const db = getDb(), m = db.prepare('SELECT content, confidence, version_count FROM memories WHERE id = ?').get(memoryId)
  if (!m) return
  try { db.prepare(`INSERT INTO fact_versions (memory_id, content, confidence, reason) VALUES (?, ?, ?, ?)`).run(memoryId, m.content, m.confidence, reason); db.prepare(`UPDATE memories SET version_count = COALESCE(version_count, 1) + 1, updated_at = unixepoch() WHERE id = ?`).run(memoryId) } catch {}
}
