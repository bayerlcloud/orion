/**
 * Inbox de decisões autônomas — registro de ações que o Orion tomou sozinho,
 * com undo quando aplicável (ex: arquivar memória salva por engano).
 */
import { getDb } from '../db/index.js'
import { emitOrionEvent } from './orion-stream.js'
import { createLogger } from '../logger.js'

const logger = createLogger('auto-log')

/**
 * kind: 'memory_saved' | 'cron_ran' | 'skill_created' | 'mission_launched' | ...
 * undoKind: 'archive_memory' | null (sem undo)
 * undoData: JSON com o necessário pro undo (ex: { memoryId })
 */
export function logAutonomousAction({ kind, description, undoKind = null, undoData = null }) {
  try {
    const db = getDb()
    const id = db.prepare(
      `INSERT INTO autonomous_actions (kind, description, undo_kind, undo_data) VALUES (?, ?, ?, ?) RETURNING id`
    ).get(kind, description, undoKind, undoData ? JSON.stringify(undoData) : null).id
    emitOrionEvent('autonomous_action', { id, kind, description: description.slice(0, 150), canUndo: !!undoKind, ts: Date.now() })
    return id
  } catch (err) {
    logger.warn({ err }, 'falha ao registrar ação autônoma')
    return null
  }
}

export function listAutonomousActions(limit = 30) {
  return getDb().prepare(
    `SELECT id, kind, description, undo_kind, undone, created_at
     FROM autonomous_actions ORDER BY created_at DESC LIMIT ?`
  ).all(limit)
}

export function undoAutonomousAction(id) {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM autonomous_actions WHERE id = ?`).get(id)
  if (!row || row.undone || !row.undo_kind) return { ok: false, error: 'ação não encontrada ou sem undo' }

  const data = row.undo_data ? JSON.parse(row.undo_data) : {}
  try {
    switch (row.undo_kind) {
      case 'archive_memory':
        db.prepare(`UPDATE memories SET archived = 1 WHERE id = ?`).run(data.memoryId)
        break
      case 'delete_cron':
        db.prepare(`UPDATE cron_jobs SET active = 0 WHERE id = ?`).run(data.jobId)
        break
      default:
        return { ok: false, error: `undo_kind desconhecido: ${row.undo_kind}` }
    }
    db.prepare(`UPDATE autonomous_actions SET undone = 1 WHERE id = ?`).run(id)
    logger.info({ id, kind: row.undo_kind }, 'undo executado')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
