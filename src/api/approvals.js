import { getDb } from '../db/index.js'
import { emitOrionEvent } from './orion-stream.js'
import { createLogger } from '../logger.js'

const logger = createLogger('approvals')

export function createApproval(question, { context = null, source = 'agent' } = {}) {
  const db = getDb()
  const id = db.prepare(
    `INSERT INTO approvals (question, context, source) VALUES (?, ?, ?) RETURNING id`
  ).get(question, context, source).id

  emitOrionEvent('approval_request', { id, question, context, ts: Date.now() })

  import('../gateway/evolution.js').then(({ sendWhatsApp }) => {
    const jid = process.env.WHATSAPP_OWNER_JID
    if (!jid) return
    const msg = `⏸️ *Aprovação necessária*\n\n${question}${context ? `\n\n_${context.slice(0, 300)}_` : ''}\n\nResponda *sim* ou *não*.`
    sendWhatsApp(jid, msg).catch(() => {})
  }).catch(() => {})

  logger.info({ id, question: question.slice(0, 80) }, 'aprovação criada')
  return id
}

export function answerApproval(id, answer, source = 'web') {
  const db = getDb()
  const row = db.prepare(`SELECT id, status FROM approvals WHERE id = ?`).get(id)
  if (!row || row.status !== 'pending') return false
  const status = /^(sim|s|yes|y|ok|aprovo|aprovar|pode|1|👍)$/i.test(String(answer).trim()) ? 'approved' : 'rejected'
  db.prepare(`UPDATE approvals SET status = ?, answer = ?, answered_at = unixepoch() WHERE id = ?`)
    .run(status, String(answer), id)
  emitOrionEvent('approval_resolved', { id, status, answer: String(answer), source, ts: Date.now() })
  logger.info({ id, status, source }, 'aprovação resolvida')
  return status
}

export function listPendingApprovals() {
  return getDb().prepare(
    `SELECT id, question, context, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10`
  ).all()
}

export function tryAnswerFromWhatsApp(text) {
  const t = String(text).trim().toLowerCase()
  if (!/^(sim|s|yes|ok|aprovo|aprovar|pode|não|nao|n|no|nego|negar|recuso|1|2|👍|👎)$/i.test(t)) return null
  const pending = listPendingApprovals()
  if (!pending.length) return null
  const status = answerApproval(pending[0].id, t, 'whatsapp')
  if (!status) return null
  return status === 'approved'
    ? `✅ Aprovado: "${pending[0].question.slice(0, 80)}"`
    : `🚫 Rejeitado: "${pending[0].question.slice(0, 80)}"`
}

export async function waitForApproval(id, timeoutMs = 15 * 60_000) {
  const db = getDb()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(id)
    if (row && row.status !== 'pending') return row.status
    await new Promise(r => setTimeout(r, 3000))
  }
  db.prepare(`UPDATE approvals SET status = 'timeout', answered_at = unixepoch() WHERE id = ? AND status = 'pending'`).run(id)
  emitOrionEvent('approval_resolved', { id, status: 'timeout', ts: Date.now() })
  return 'timeout'
}
