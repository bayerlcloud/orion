/**
 * Session Registry — gerencia sessões Claude Code nomeadas e visíveis no plugin.
 *
 * Cada sessão tem um nome intencional (ex: "Projeto: Brandspace") e um
 * claude_session_id persistido para retomada via --resume.
 */

import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('registry')

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function getSession(name) {
  return getDb()
    .prepare(`SELECT * FROM session_registry WHERE name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
    .get(name) ?? null
}

export function getSessionByProject(project) {
  return getDb()
    .prepare(`SELECT * FROM session_registry WHERE project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`)
    .get(project) ?? null
}

export function createSession(name, { project = null, role = 'executor' } = {}) {
  const db = getDb()
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO session_registry (id, name, project, role, status, created_at)
    VALUES (?, ?, ?, ?, 'active', unixepoch())
  `).run(id, name, project, role)
  log.info(`[registry] nova sessão: "${name}" (projeto: ${project ?? 'none'})`)
  return db.prepare('SELECT * FROM session_registry WHERE id = ?').get(id)
}

export function updateClaudeSessionId(registryId, claudeSessionId) {
  getDb().prepare(`
    UPDATE session_registry
    SET claude_session_id = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(claudeSessionId, registryId)
}

export function closeSession(name) {
  getDb().prepare(`
    UPDATE session_registry SET status = 'closed', closed_at = unixepoch() WHERE name = ?
  `).run(name)
}

export function listActiveSessions() {
  return getDb()
    .prepare(`SELECT * FROM session_registry WHERE status = 'active' ORDER BY updated_at DESC`)
    .all()
}

// ── Get-or-create (padrão principal de uso) ───────────────────────────────────

export function getOrCreate(name, { project = null, role = 'executor' } = {}) {
  return getSession(name) ?? createSession(name, { project, role })
}

// ── Nome canônico por projeto ─────────────────────────────────────────────────

export function projectSessionName(project) {
  const DISPLAY = {
    brandspace:      'Projeto: Brandspace',
    trackingmachine: 'Projeto: TrackingMachine',
    ralab:           'Projeto: Ralab',
    fisioexpert:     'Projeto: FisioExpert',
    abcprime:        'Projeto: ABCPrime',
    orion:           'Sistema: Orion',
  }
  return DISPLAY[project] ?? `Projeto: ${project}`
}
