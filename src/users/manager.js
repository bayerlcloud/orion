import { getDb } from '../db/index.js'
import { hashPassword, verifyPassword } from '../auth.js'

const PUBLIC_FIELDS = 'id, username, display_name, email, role, avatar_color, is_active, notes, created_at, last_login_at'

export function listUsers() {
  return getDb().prepare(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY role DESC, created_at ASC`).all()
}

export function getUserById(id) {
  return getDb().prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id)
}

export function getUserByUsername(username) {
  return getDb().prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE username = ?`).get(username)
}

export function createUser({ username, display_name, email, role = 'collaborator', password, avatar_color = '#8b5cf6', notes }) {
  const db = getDb()
  if (!username || !password) throw new Error('username e password são obrigatórios')
  if (!['owner', 'collaborator'].includes(role)) throw new Error('role inválido')
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) throw new Error('Usuário já existe')
  const hash = hashPassword(password)
  const result = db.prepare(
    `INSERT INTO users (username, display_name, email, role, password_hash, avatar_color, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(username, display_name || username, email || null, role, hash, avatar_color, notes || null)
  return result.lastInsertRowid
}

export function updateUser(id, { display_name, email, avatar_color, is_active, notes }) {
  const fields = [], vals = []
  if (display_name !== undefined) { fields.push('display_name = ?'); vals.push(display_name) }
  if (email       !== undefined) { fields.push('email = ?');        vals.push(email || null) }
  if (avatar_color !== undefined){ fields.push('avatar_color = ?'); vals.push(avatar_color) }
  if (is_active   !== undefined) { fields.push('is_active = ?');    vals.push(is_active ? 1 : 0) }
  if (notes       !== undefined) { fields.push('notes = ?');        vals.push(notes || null) }
  if (!fields.length) return
  vals.push(id)
  getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
}

export function resetPassword(id, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error('Senha muito curta (mínimo 6 chars)')
  const hash = hashPassword(newPassword)
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id)
}

export function changeOwnPassword(id, currentPassword, newPassword) {
  const db = getDb()
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)
  if (!user) throw new Error('Usuário não encontrado')
  if (!verifyPassword(currentPassword, user.password_hash)) throw new Error('Senha atual incorreta')
  resetPassword(id, newPassword)
}

// ── Audit Log ────────────────────────────────────────────────────────────────

export function insertAuditLog({ user_id, username, method, path, ip, status_code, duration_ms, body_summary }) {
  try {
    getDb().prepare(
      `INSERT INTO audit_log (user_id, username, method, path, ip, status_code, duration_ms, body_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(user_id ?? null, username ?? 'anon', method, path, ip ?? null, status_code ?? null, duration_ms ?? null, body_summary ?? null)
  } catch {}
}

export function getAuditLog({ userId, limit = 200, offset = 0, since } = {}) {
  const db = getDb()
  const conds = []
  const vals  = []
  if (userId) { conds.push('user_id = ?'); vals.push(userId) }
  if (since)  { conds.push('created_at >= ?'); vals.push(since) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  vals.push(limit, offset)
  return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...vals)
}

// ── Timesheet ────────────────────────────────────────────────────────────────

export function getTimesheet(userId, days = 30) {
  const db = getDb()
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const logs = db.prepare(`SELECT created_at FROM audit_log WHERE user_id=? AND created_at>? ORDER BY created_at ASC`).all(userId, since)
  const GAP = 15 * 60 // 15min gap = nova sessão de trabalho
  const byDay = {}
  let sessionStart = null, prev = null
  for (const { created_at } of logs) {
    const d = new Date(created_at * 1000).toISOString().slice(0, 10)
    if (!byDay[d]) byDay[d] = 0
    if (!prev || created_at - prev > GAP) { sessionStart = created_at }
    else { byDay[d] += created_at - prev }
    prev = created_at
  }
  return Object.entries(byDay).sort().map(([d, secs]) => ({ date: d, minutes: Math.round(secs / 60) }))
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function listTasks(userId) {
  return getDb().prepare(`SELECT * FROM collab_tasks WHERE user_id=? ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, priority DESC, created_at DESC`).all(userId)
}

export function createTask(userId, { title, description, priority = 'normal', due_date, created_by }) {
  if (!title?.trim()) throw new Error('title obrigatório')
  const r = getDb().prepare(`INSERT INTO collab_tasks (user_id, title, description, priority, due_date, created_by) VALUES (?,?,?,?,?,?)`).run(userId, title.trim(), description || null, priority, due_date || null, created_by || null)
  return r.lastInsertRowid
}

export function updateTask(taskId, { title, description, status, priority, due_date }) {
  const fields = [], vals = []
  if (title       !== undefined) { fields.push('title=?');       vals.push(title) }
  if (description !== undefined) { fields.push('description=?'); vals.push(description || null) }
  if (status      !== undefined) { fields.push('status=?');      vals.push(status) }
  if (priority    !== undefined) { fields.push('priority=?');    vals.push(priority) }
  if (due_date    !== undefined) { fields.push('due_date=?');    vals.push(due_date || null) }
  if (!fields.length) return
  fields.push('updated_at=unixepoch()')
  vals.push(taskId)
  getDb().prepare(`UPDATE collab_tasks SET ${fields.join(',')} WHERE id=?`).run(...vals)
}

export function deleteTask(taskId) {
  getDb().prepare(`DELETE FROM collab_tasks WHERE id=?`).run(taskId)
}

// ── Permissões granulares ─────────────────────────────────────────────────────

export function getUserPermissions(userId) {
  return getDb().prepare(`SELECT resource, allowed FROM user_permissions WHERE user_id=?`).all(userId)
}

export function setUserPermission(userId, resource, allowed) {
  getDb().prepare(`INSERT INTO user_permissions (user_id, resource, allowed) VALUES (?,?,?) ON CONFLICT(user_id, resource) DO UPDATE SET allowed=excluded.allowed`).run(userId, resource, allowed ? 1 : 0)
}

export function setUserPermissions(userId, permissions) {
  const db = getDb()
  db.prepare(`DELETE FROM user_permissions WHERE user_id=?`).run(userId)
  for (const [resource, allowed] of Object.entries(permissions)) {
    db.prepare(`INSERT INTO user_permissions (user_id, resource, allowed) VALUES (?,?,?)`).run(userId, resource, allowed ? 1 : 0)
  }
}

// ── Budget ────────────────────────────────────────────────────────────────────

export function getBudget(userId) {
  return getDb().prepare(`SELECT token_budget_monthly, tokens_this_month, budget_notified_at FROM users WHERE id=?`).get(userId)
}

export function setBudget(userId, monthlyTokens) {
  getDb().prepare(`UPDATE users SET token_budget_monthly=?, tokens_this_month=0, budget_notified_at=NULL WHERE id=?`).run(monthlyTokens || null, userId)
}

// Emitter simples para SSE do activity stream
const _listeners = new Set()
export function onAuditEntry(cb) { _listeners.add(cb); return () => _listeners.delete(cb) }
export function emitAuditEntry(entry) { _listeners.forEach(cb => { try { cb(entry) } catch {} }) }
