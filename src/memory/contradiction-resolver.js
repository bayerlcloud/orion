/**
 * Contradiction Resolver — resolução ATIVA de contradições.
 *
 * O contradiction-scanner.js detecta e marca contradições no metadata.
 * Este módulo vai além: mantém uma fila de perguntas a fazer ao usuário
 * para resolver contradições automaticamente.
 *
 * Fluxo:
 * 1. Ao detectar contradição entre A e B, enfileira uma pergunta
 * 2. A pergunta é injetada no próximo turno do usuário
 * 3. Quando usuário responde, persiste a versão correta com conf=0.95
 *    e arquiva a incorreta
 */

import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('contr-resolver')

/**
 * Enfileira contradições detectadas para resolução ativa.
 * Chamado pelo contradiction-scanner após marcar pares.
 */
export function queueForResolution(pairs) {
  if (!pairs || pairs.length === 0) return 0
  const db = getDb()
  let queued = 0

  for (const { a, b, score } of pairs) {
    // Não reenfileira se já existe uma resolução pendente para este par
    try {
      const existing = db.prepare(`
        SELECT id FROM contradiction_queue
        WHERE (memory_id_a = ? AND memory_id_b = ?) OR (memory_id_a = ? AND memory_id_b = ?)
          AND resolved = 0
      `).get(a, b, b, a)
      if (existing) continue
    } catch {}

    // Busca conteúdo das duas memórias
    let memA, memB
    try {
      memA = db.prepare('SELECT content FROM memories WHERE id = ?').get(a)
      memB = db.prepare('SELECT content FROM memories WHERE id = ?').get(b)
    } catch {}
    if (!memA || !memB) continue

    const question = buildResolutionQuestion(memA.content, memB.content)
    if (!question) continue

    try {
      db.prepare(`
        INSERT INTO contradiction_queue
          (memory_id_a, memory_id_b, content_a, content_b, question, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      `).run(a, b, memA.content, memB.content, question, score)
      queued++
    } catch {}
  }

  if (queued > 0) log.info({ queued }, '[resolver] contradições enfileiradas para resolução')
  return queued
}

/**
 * Retorna a próxima pergunta pendente de resolução (se houver).
 * Injetada no próximo turno pelo orion.js.
 */
export function getNextResolutionQuestion() {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT id, question, memory_id_a, memory_id_b, content_a, content_b
      FROM contradiction_queue
      WHERE resolved = 0
      ORDER BY score DESC, created_at ASC
      LIMIT 1
    `).get()
  } catch { return null }
}

/**
 * Resolve uma contradição com base na resposta do usuário.
 * @param {string} queueId
 * @param {'a'|'b'|'both_wrong'|'both_right'} resolution
 * @param {string} [correctedContent] - usado quando ambas estão erradas
 */
export function resolveContradiction(queueId, resolution, correctedContent = null) {
  const db = getDb()
  try {
    const q = db.prepare('SELECT * FROM contradiction_queue WHERE id = ?').get(queueId)
    if (!q) return false

    const now = Math.floor(Date.now() / 1000)

    if (resolution === 'a' || resolution === 'b') {
      const keepId = resolution === 'a' ? q.memory_id_a : q.memory_id_b
      const archiveId = resolution === 'a' ? q.memory_id_b : q.memory_id_a

      // Reforça a correta
      db.prepare(`
        UPDATE memories SET confidence = MIN(0.95, confidence + 0.15),
          updated_at = ? WHERE id = ?
      `).run(now, keepId)

      // Arquiva a incorreta
      db.prepare(`
        UPDATE memories SET archived = 1, confidence = 0.05,
          updated_at = ? WHERE id = ?
      `).run(now, archiveId)

      log.info({ keepId, archiveId }, '[resolver] contradição resolvida pelo usuário')
    } else if (resolution === 'both_wrong' && correctedContent) {
      // Arquiva ambas, salva nova versão
      db.prepare('UPDATE memories SET archived = 1, updated_at = ? WHERE id IN (?, ?)').run(now, q.memory_id_a, q.memory_id_b)
      // O caller deve chamar saveMemory separadamente com o conteúdo correto
    }

    // Marca como resolvida
    db.prepare(`
      UPDATE contradiction_queue
      SET resolved = 1, resolved_at = ?, resolution = ?
      WHERE id = ?
    `).run(now, resolution, queueId)

    return true
  } catch (err) {
    log.warn({ err: err.message }, '[resolver] erro ao resolver contradição')
    return false
  }
}

/**
 * Gera uma pergunta de resolução natural a partir de dois fatos conflitantes.
 */
function buildResolutionQuestion(contentA, contentB) {
  if (!contentA || !contentB) return null
  const aShort = contentA.slice(0, 100)
  const bShort = contentB.slice(0, 100)
  return `⚠️ *Contradição detectada* — qual é o correto?\n(A) ${aShort}\n(B) ${bShort}\n\nResponda: A, B, ou corrija manualmente`
}

/** Lista contradições pendentes. */
export function listPendingContradictions(limit = 10) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT * FROM contradiction_queue
      WHERE resolved = 0
      ORDER BY score DESC
      LIMIT ?
    `).all(limit)
  } catch { return [] }
}

/** Stats da fila de resolução. */
export function getResolutionStats() {
  const db = getDb()
  try {
    return {
      pending:  db.prepare('SELECT COUNT(*) AS n FROM contradiction_queue WHERE resolved = 0').get()?.n ?? 0,
      resolved: db.prepare('SELECT COUNT(*) AS n FROM contradiction_queue WHERE resolved = 1').get()?.n ?? 0,
    }
  } catch { return { pending: 0, resolved: 0 } }
}
