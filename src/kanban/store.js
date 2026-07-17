import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const logger = createLogger('kanban-store')

export function createBoard(name) {
  const db = getDb()
  const id = crypto.randomUUID()
  try { db.prepare(`INSERT INTO kanban_boards (id, name) VALUES (?, ?)`).run(id, name) } catch {}
  return db.prepare(`SELECT * FROM kanban_boards WHERE name = ?`).get(name)
}

export function getBoard(nameOrId) {
  const db = getDb()
  return db.prepare(`SELECT * FROM kanban_boards WHERE id = ? OR name = ? LIMIT 1`).get(nameOrId, nameOrId)
}

export function addTask(boardId, { title, description, priority = 0, dependsOn = [] }) {
  const db = getDb()
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO kanban_tasks (id, board_id, title, description, priority, depends_on) VALUES (?, ?, ?, ?, ?, ?)`).run(id, boardId, title, description ?? null, priority, JSON.stringify(dependsOn))
  return id
}

export function getNextTask(boardId, workerId) {
  const db = getDb()
  const pending = db.prepare(`SELECT * FROM kanban_tasks WHERE board_id = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC`).all(boardId)
  for (const task of pending) {
    const deps = JSON.parse(task.depends_on ?? '[]')
    if (!deps.length) return claimTask(task.id, workerId)
    if (!deps.length) continue
    const doneCount = db.prepare(`SELECT COUNT(*) as n FROM kanban_tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND status = 'done'`).get(...deps)
    if (doneCount.n === deps.length) return claimTask(task.id, workerId)
  }
  return null
}

function claimTask(taskId, workerId) {
  const db = getDb()
  db.prepare(`UPDATE kanban_tasks SET status = 'in_progress', assigned_to = ?, started_at = unixepoch() WHERE id = ?`).run(workerId, taskId)
  return db.prepare(`SELECT * FROM kanban_tasks WHERE id = ?`).get(taskId)
}

export function completeTask(taskId, result) {
  getDb().prepare(`UPDATE kanban_tasks SET status = 'done', result = ?, completed_at = unixepoch(), assigned_to = NULL WHERE id = ?`).run(result ? result.slice(0, 10000) : null, taskId)
}

export function failTask(taskId, error) {
  getDb().prepare(`UPDATE kanban_tasks SET status = 'failed', error = ?, completed_at = unixepoch(), assigned_to = NULL WHERE id = ?`).run(error ? error.slice(0, 2000) : null, taskId)
}

export function heartbeat(workerId, taskId) {
  const db = getDb()
  db.prepare(`UPDATE kanban_workers SET last_beat = unixepoch(), current_task = ? WHERE id = ?`).run(taskId, workerId)
  db.prepare(`UPDATE kanban_tasks SET heartbeat_at = unixepoch() WHERE id = ?`).run(taskId)
}

export function recoverStaleTasks(staleThresholdSecs = 120) {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - staleThresholdSecs
  const r = db.prepare(`UPDATE kanban_tasks SET status = 'pending', assigned_to = NULL, started_at = NULL WHERE status = 'in_progress' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`).run(cutoff)
  if (r.changes) logger.warn({ recovered: r.changes }, 'tasks stale recuperadas')
  return r.changes
}

export function cascadeFailures(boardId) {
  const db = getDb()
  let totalCascaded = 0
  // Propaga falhas iterativamente até não haver mais cascata
  for (let pass = 0; pass < 10; pass++) {
    const pending = db.prepare(`SELECT id, depends_on FROM kanban_tasks WHERE board_id = ? AND status = 'pending'`).all(boardId)
    let cascaded = 0
    for (const task of pending) {
      const deps = JSON.parse(task.depends_on ?? '[]')
      if (!deps.length) continue
      const failedDeps = db.prepare(`SELECT COUNT(*) as n FROM kanban_tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND status = 'failed'`).get(...deps)
      if (failedDeps.n > 0) {
        db.prepare(`UPDATE kanban_tasks SET status = 'failed', error = 'dependência falhou', completed_at = unixepoch() WHERE id = ?`).run(task.id)
        cascaded++
      }
    }
    totalCascaded += cascaded
    if (cascaded === 0) break
  }
  if (totalCascaded > 0) logger.warn({ boardId, cascaded: totalCascaded }, 'cascata de falhas aplicada')
  return totalCascaded
}

export function getBoardStatus(boardId) {
  const db = getDb()
  const counts = db.prepare(`SELECT status, COUNT(*) as n FROM kanban_tasks WHERE board_id = ? GROUP BY status`).all(boardId)
  return Object.fromEntries(counts.map(r => [r.status, r.n]))
}

export function getBoardTasks(boardId) {
  return getDb().prepare(`SELECT id, title, status, priority, assigned_to, result, error, created_at, completed_at FROM kanban_tasks WHERE board_id = ? ORDER BY created_at ASC`).all(boardId)
}
