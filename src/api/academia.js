import { getDb } from '../db/index.js'
import { getMemoryQualityMetrics } from './quality-scorer.js'
import { HALF_LIFE_DAYS } from '../memory/decay-config.js'

const MIN_TRUST = 0.15
const RECENCY_LAMBDA = 0.0001
const nowSec = () => Math.floor(Date.now() / 1000)

function count(db, sql, ...params) {
  try { return db.prepare(sql).get(...params)?.n ?? 0 } catch { return 0 }
}

export function getMechanismStats() {
  const db = getDb()
  const bySourceTool = {}; const memoryTypes = {}
  try { for (const r of db.prepare(`SELECT source_tool, COUNT(*) n FROM memories WHERE archived=0 GROUP BY source_tool`).all()) { if (r.source_tool) bySourceTool[r.source_tool] = r.n } } catch {}
  try { for (const r of db.prepare(`SELECT type, COUNT(*) n FROM memories WHERE archived=0 GROUP BY type`).all()) memoryTypes[r.type] = r.n } catch {}
  const tables = {
    memories: count(db, `SELECT COUNT(*) n FROM memories WHERE archived=0`),
    memories_archived: count(db, `SELECT COUNT(*) n FROM memories WHERE archived=1`),
    entities: count(db, `SELECT COUNT(*) n FROM entities`),
    relations: count(db, `SELECT COUNT(*) n FROM relations`),
    skills: count(db, `SELECT COUNT(*) n FROM skills WHERE status!='archived'`),
    causal_links: count(db, `SELECT COUNT(*) n FROM causal_links`),
    co_retrievals: count(db, `SELECT COUNT(*) n FROM co_retrievals`),
    contradiction_pending: count(db, `SELECT COUNT(*) n FROM contradiction_queue WHERE resolved=0`),
    cron_jobs: count(db, `SELECT COUNT(*) n FROM cron_jobs WHERE status='active'`),
    sessions: count(db, `SELECT COUNT(*) n FROM sessions`),
  }
  let avgConf = 0; try { avgConf = db.prepare(`SELECT AVG(confidence) a FROM memories WHERE archived=0`).get()?.a ?? 0 } catch {}
  return { bySourceTool, memoryTypes, tables, avgConfidence: Math.round(avgConf * 1000) / 1000, at: nowSec() }
}

export function getHealthRadar() {
  const db = getDb()
  const s = getMechanismStats()
  let quality = {}; try { quality = getMemoryQualityMetrics() } catch {}
  const signals = []
  const push = (level, text) => signals.push({ level, text })
  if (s.tables.memories >= 380) push('warn', `Memory bank perto da capacidade (${s.tables.memories}) — retrieval pode degradar.`)
  else push('ok', `Memory bank saudável (${s.tables.memories} memórias ativas)`)
  if (s.avgConfidence < 0.4) push('warn', `Confiança média baixa (${s.avgConfidence}) — muita memória crua/não-confirmada.`)
  else push('ok', `Confiança média ${s.avgConfidence}`)
  if (s.tables.contradiction_pending > 0) push('action', `${s.tables.contradiction_pending} contradição(es) esperando resolução.`)
  return { score: quality.quality_score ?? null, quality, stats: s, signals }
}

function tokset(s) { return new Set(String(s).toLowerCase().split(/\W+/).filter(t => t.length > 3)) }
function jaccard(a, b) { const A = tokset(a), B = tokset(b); if (!A.size || !B.size) return 0; let i = 0; for (const t of A) if (B.has(t)) i++; return i / (A.size + B.size - i) }

export function retrievalDebug(query, limit = 12) {
  const db = getDb()
  if (!query?.trim()) return { query, candidates: [] }
  const ftsQuery = String(query).replace(/[^\w\s]/g, ' ').trim() || '""'
  let rows = []
  try { rows = db.prepare(`SELECT m.id, m.content, m.type, m.confidence, m.created_at, m.last_accessed, m.access_count, m.tags, m.category, m.helpful_votes, m.unhelpful_votes, bm25(memories_fts) AS bm25_score FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? AND m.archived = 0 ORDER BY bm25_score LIMIT ?`).all(ftsQuery, limit) } catch {}
  const now = nowSec()
  return { query, minTrust: MIN_TRUST, candidates: rows.map(r => {
    const bm25 = r.bm25_score ? Math.abs(r.bm25_score) : 0
    const ageDays = (now - (r.last_accessed ?? r.created_at)) / 86400
    const decay = Math.pow(2, -ageDays / (HALF_LIFE_DAYS[r.category] ?? HALF_LIFE_DAYS.general))
    return { id: r.id, content: r.content.slice(0, 140), category: r.category, type: r.type, confidence: Math.round(r.confidence * 100) / 100, bm25Norm: Math.round(bm25 / (bm25 + 1) * 1000) / 1000, decay: Math.round(decay * 1000) / 1000, adjustedConf: Math.round(r.confidence * decay * 1000) / 1000, jaccard: Math.round(jaccard(query, r.content) * 1000) / 1000, ageDays: Math.round(ageDays * 10) / 10 }
  }) }
}

export function traceMemory(id) {
  const db = getDb()
  let m; try { m = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) } catch {}
  if (!m) return { error: 'memória não encontrada' }
  const now = nowSec()
  const ageDays = (now - (m.last_accessed ?? m.created_at)) / 86400
  const decay = Math.pow(2, -ageDays / (HALF_LIFE_DAYS[m.category] ?? HALF_LIFE_DAYS.general))
  let meta = {}; try { meta = JSON.parse(m.metadata ?? '{}') } catch {}
  return { id: m.id, content: m.content, ageDays: Math.round(ageDays * 10) / 10, journey: { ingestao: { source_tool: m.source_tool ?? m.source, created_at: m.created_at }, armazenamento: { type: m.type, category: m.category }, score: { confidence: m.confidence, decay: Math.round(decay * 1000) / 1000, adjustedConf: Math.round(m.confidence * decay * 1000) / 1000, access_count: m.access_count }, consolidacao: { archived: !!m.archived, last_audit: meta.last_audit ?? null } } }
}

export function listRecentMemoriesForTrace(limit = 15) {
  const db = getDb()
  try { return db.prepare(`SELECT id, content, category, confidence FROM memories WHERE archived=0 ORDER BY created_at DESC LIMIT ?`).all(limit).map(r => ({ ...r, content: r.content.slice(0, 80) })) } catch { return [] }
}

export function saveImprovement({ mechanism, note }) {
  const db = getDb()
  if (!note?.trim()) return { ok: false, error: 'nota vazia' }
  try { db.prepare(`INSERT INTO improvements (mechanism, note) VALUES (?, ?)`).run(mechanism ?? 'geral', note.trim().slice(0, 1000)); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}
export function listImprovements(limit = 100) {
  try { return getDb().prepare(`SELECT id, mechanism, note, status, created_at FROM improvements ORDER BY created_at DESC LIMIT ?`).all(limit) } catch { return [] }
}
export function updateImprovement(id, status) {
  try { getDb().prepare(`UPDATE improvements SET status=? WHERE id=?`).run(status, id); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
}
