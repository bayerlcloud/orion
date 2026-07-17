/**
 * Academia API — dados ao vivo para a página /academia virar cockpit de arquitetura.
 *
 *   getMechanismStats()  — números reais por mecanismo (overlay vivo, ideia #4)
 *   getHealthRadar()     — sinais de saúde/gaps (ideia #8)
 *   retrievalDebug(q)    — breakdown do score por memória (simulador, ideias #2/#3)
 *   traceMemory(id)      — jornada de uma memória (ideia #10)
 *   saveImprovement/listImprovements — backlog de melhorias (ideia #7)
 */

import { getDb } from '../db/index.js'
import { getMemoryQualityMetrics } from './quality-scorer.js'
import { HALF_LIFE_DAYS } from '../memory/decay-config.js'

const MIN_TRUST = 0.15
const RECENCY_LAMBDA = 0.0001
const nowSec = () => Math.floor(Date.now() / 1000)

function count(db, sql, ...params) {
  try { return db.prepare(sql).get(...params)?.n ?? 0 } catch { return 0 }
}

// ── #4 — estatísticas ao vivo por mecanismo ───────────────────────────────────
export function getMechanismStats() {
  const db = getDb()
  const bySourceTool = {}
  try {
    for (const r of db.prepare(`SELECT source_tool, COUNT(*) n FROM memories WHERE archived=0 GROUP BY source_tool`).all()) {
      if (r.source_tool) bySourceTool[r.source_tool] = r.n
    }
  } catch {}

  const memoryTypes = {}
  try {
    for (const r of db.prepare(`SELECT type, COUNT(*) n FROM memories WHERE archived=0 GROUP BY type`).all()) memoryTypes[r.type] = r.n
  } catch {}

  const tables = {
    memories: count(db, `SELECT COUNT(*) n FROM memories WHERE archived=0`),
    memories_archived: count(db, `SELECT COUNT(*) n FROM memories WHERE archived=1`),
    entities: count(db, `SELECT COUNT(*) n FROM entities`),
    relations: count(db, `SELECT COUNT(*) n FROM relations`),
    skills: count(db, `SELECT COUNT(*) n FROM skills WHERE status!='archived'`),
    skills_auto: count(db, `SELECT COUNT(*) n FROM skills WHERE source='synthesizer'`),
    causal_links: count(db, `SELECT COUNT(*) n FROM causal_links`),
    temporal_events: count(db, `SELECT COUNT(*) n FROM temporal_events`),
    co_retrievals: count(db, `SELECT COUNT(*) n FROM co_retrievals`),
    contradiction_pending: count(db, `SELECT COUNT(*) n FROM contradiction_queue WHERE resolved=0`),
    dedup_pending: count(db, `SELECT COUNT(*) n FROM dedup_queue WHERE resolved=0`),
    memory_snapshots: count(db, `SELECT COUNT(*) n FROM memory_snapshots`),
    drift_log: count(db, `SELECT COUNT(*) n FROM drift_log`),
    task_patterns: count(db, `SELECT COUNT(*) n FROM task_patterns`),
    skill_rejections: count(db, `SELECT COUNT(*) n FROM skill_rejections`),
    skill_patches: count(db, `SELECT COUNT(*) n FROM skill_patches`),
    tier2_summaries: count(db, `SELECT COUNT(*) n FROM tier2_summaries`),
    proactive_questions: count(db, `SELECT COUNT(*) n FROM proactive_questions WHERE answered=0`),
    cron_jobs: count(db, `SELECT COUNT(*) n FROM cron_jobs WHERE status='active'`),
    sessions: count(db, `SELECT COUNT(*) n FROM sessions`),
  }
  let avgConf = 0
  try { avgConf = db.prepare(`SELECT AVG(confidence) a FROM memories WHERE archived=0`).get()?.a ?? 0 } catch {}

  return { bySourceTool, memoryTypes, tables, avgConfidence: Math.round(avgConf * 1000) / 1000, at: nowSec() }
}

// ── #8 — radar de saúde / gaps ─────────────────────────────────────────────────
export function getHealthRadar() {
  const db = getDb()
  const s = getMechanismStats()
  let quality = {}
  try { quality = getMemoryQualityMetrics() } catch {}

  const signals = []
  const push = (level, text) => signals.push({ level, text })

  // capacidade do memory bank (warning real visto em ~400)
  if (s.tables.memories >= 380) push('warn', `Memory bank perto da capacidade (${s.tables.memories}) — retrieval pode degradar. Considerar arquivamento mais agressivo.`)
  else push('ok', `Memory bank saudável (${s.tables.memories} memórias ativas)`)

  // confiança média
  if (s.avgConfidence < 0.4) push('warn', `Confiança média baixa (${s.avgConfidence}) — muita memória crua/não-confirmada.`)
  else push('ok', `Confiança média ${s.avgConfidence}`)

  // pendências que precisam de você
  if (s.tables.contradiction_pending > 0) push('action', `${s.tables.contradiction_pending} contradição(ões) esperando resolução no WhatsApp.`)
  if (s.tables.dedup_pending > 0) push('action', `${s.tables.dedup_pending} par(es) de duplicatas esperando votação.`)
  if (s.tables.proactive_questions > 0) push('action', `${s.tables.proactive_questions} pergunta(s) proativa(s) na fila.`)

  // skills com alta rejeição
  try {
    const bad = db.prepare(`
      SELECT skill_name, COUNT(*) total, SUM(CASE WHEN approved=0 THEN 1 ELSE 0 END) rej
      FROM skill_rejections WHERE created_at > unixepoch()-86400*30
      GROUP BY skill_name HAVING rej>0 AND CAST(rej AS REAL)/total > 0.2 ORDER BY rej DESC LIMIT 3`).all()
    for (const b of bad) push('warn', `Skill "${b.skill_name}" com ${Math.round(100*b.rej/b.total)}% de rejeição — candidata a patch.`)
  } catch {}

  // mecanismos sem nenhuma atividade (cold spots)
  const expectedTools = ['haiku-extraction','background-review','pre-compress','delegate']
  const cold = expectedTools.filter(t => !(s.bySourceTool[t] > 0))
  if (cold.length) push('info', `Sem registros ainda de: ${cold.join(', ')}.`)

  // drift recente
  if (s.tables.drift_log > 0) push('info', `${s.tables.drift_log} evento(s) de drift semântico registrados.`)

  const score = quality.quality_score ?? null
  return { score, quality, stats: s, signals }
}

// ── #2/#3 — breakdown do score por memória (simulador + sliders) ───────────────
function tokset(s) { return new Set(String(s).toLowerCase().split(/\W+/).filter(t => t.length > 3)) }
function jaccard(a, b) {
  const A = tokset(a), B = tokset(b)
  if (!A.size || !B.size) return 0
  let i = 0; for (const t of A) if (B.has(t)) i++
  return i / (A.size + B.size - i)
}

export function retrievalDebug(query, limit = 12) {
  const db = getDb()
  if (!query || !query.trim()) return { query, candidates: [] }
  const ftsQuery = String(query).replace(/[^\w\s]/g, ' ').trim() || '""'
  let rows = []
  try {
    rows = db.prepare(`
      SELECT m.id, m.content, m.type, m.confidence, m.created_at, m.last_accessed, m.access_count,
             m.tags, m.category, m.helpful_votes, m.unhelpful_votes, bm25(memories_fts) AS bm25_score
      FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.archived = 0
      ORDER BY bm25_score LIMIT ?`).all(ftsQuery, limit)
  } catch { rows = [] }

  const now = nowSec()
  const candidates = rows.map(r => {
    const bm25 = r.bm25_score ? Math.abs(r.bm25_score) : 0
    const bm25Norm = bm25 / (bm25 + 1)
    const ageSec = now - r.created_at
    const recency = Math.exp(-RECENCY_LAMBDA * ageSec)
    const jac = jaccard(query, r.content + ' ' + (r.tags ?? ''))
    const ageDays = (now - (r.last_accessed ?? r.created_at)) / 86400
    const halflife = HALF_LIFE_DAYS[r.category] ?? HALF_LIFE_DAYS.general
    const decay = Math.pow(2, -ageDays / halflife)
    const adjustedConf = r.confidence * decay
    const hv = r.helpful_votes ?? 0, uv = r.unhelpful_votes ?? 0
    const feedback = (hv > 0 || uv > 0) ? (hv - uv * 2) / (hv + uv * 2 + 1) * 0.08 : 0
    return {
      id: r.id, content: r.content.slice(0, 140), category: r.category, type: r.type,
      confidence: Math.round(r.confidence * 100) / 100,
      bm25Norm: Math.round(bm25Norm * 1000) / 1000,
      recency: Math.round(recency * 1000) / 1000,
      jaccard: Math.round(jac * 1000) / 1000,
      decay: Math.round(decay * 1000) / 1000,
      adjustedConf: Math.round(adjustedConf * 1000) / 1000,
      feedback: Math.round(feedback * 1000) / 1000,
      ageDays: Math.round(ageDays * 10) / 10,
      belowTrust: adjustedConf < MIN_TRUST,
    }
  })
  return { query, minTrust: MIN_TRUST, candidates }
}

// ── #10 — rastrear a jornada de uma memória ────────────────────────────────────
export function traceMemory(id) {
  const db = getDb()
  let m
  try { m = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) } catch {}
  if (!m) return { error: 'memória não encontrada' }

  const now = nowSec()
  const ageDays = (now - (m.last_accessed ?? m.created_at)) / 86400
  const halflife = HALF_LIFE_DAYS[m.category] ?? HALF_LIFE_DAYS.general
  const decay = Math.pow(2, -ageDays / halflife)

  let meta = {}; try { meta = JSON.parse(m.metadata ?? '{}') } catch {}
  const snapshots = count(db, `SELECT COUNT(*) n FROM memory_snapshots WHERE memory_id=?`, id)
  const drifts = count(db, `SELECT COUNT(*) n FROM drift_log WHERE memory_id=?`, id)
  const inContradiction = count(db, `SELECT COUNT(*) n FROM contradiction_queue WHERE (memory_id_a=? OR memory_id_b=?) AND resolved=0`, id, id)
  let hasVector = 0; try { hasVector = count(db, `SELECT COUNT(*) n FROM vec_memories WHERE memory_rowid=?`, m.rowid) } catch {}

  return {
    id: m.id,
    content: m.content,
    journey: {
      ingestao: { source_tool: m.source_tool ?? m.source, source_channel: m.source_channel, created_at: m.created_at },
      armazenamento: { type: m.type, category: m.category, hasVector: !!hasVector, tags: (() => { try { return JSON.parse(m.tags ?? '[]') } catch { return [] } })() },
      score: { confidence: m.confidence, decay: Math.round(decay * 1000) / 1000, adjustedConf: Math.round(m.confidence * decay * 1000) / 1000, access_count: m.access_count, helpful: m.helpful_votes ?? 0, unhelpful: m.unhelpful_votes ?? 0 },
      consolidacao: { archived: !!m.archived, version_count: m.version_count ?? 1, last_audit: meta.last_audit ?? null, ground_truth: meta.ground_truth ?? null },
      raciocinio: { snapshots, drifts, inContradiction: !!inContradiction },
    },
    ageDays: Math.round(ageDays * 10) / 10,
  }
}

export function listRecentMemoriesForTrace(limit = 15) {
  const db = getDb()
  try {
    return db.prepare(`SELECT id, content, category, confidence FROM memories WHERE archived=0 ORDER BY created_at DESC LIMIT ?`).all(limit)
      .map(r => ({ ...r, content: r.content.slice(0, 80) }))
  } catch { return [] }
}

// ── #7 — backlog de melhorias de arquitetura ──────────────────────────────────
export function saveImprovement({ mechanism, note }) {
  const db = getDb()
  if (!note || !note.trim()) return { ok: false, error: 'nota vazia' }
  try {
    db.prepare(`INSERT INTO improvements (mechanism, note) VALUES (?, ?)`).run(mechanism ?? 'geral', note.trim().slice(0, 1000))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}
export function listImprovements(limit = 100) {
  const db = getDb()
  try { return db.prepare(`SELECT id, mechanism, note, status, created_at FROM improvements ORDER BY created_at DESC LIMIT ?`).all(limit) }
  catch { return [] }
}
export function updateImprovement(id, status) {
  const db = getDb()
  try { db.prepare(`UPDATE improvements SET status=? WHERE id=?`).run(status, id); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}
