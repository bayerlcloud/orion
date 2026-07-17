import { getDb } from '../db/index.js'

const MODEL_PRICES = {
  haiku:  { input: 0.25,  output: 0.75  },
  sonnet: { input: 3.0,   output: 15.0  },
  opus:   { input: 15.0,  output: 75.0  },
}

function calcCost(inputTok, outputTok, model = 'sonnet') {
  const p = MODEL_PRICES[model] || MODEL_PRICES.sonnet
  return ((inputTok || 0) / 1_000_000) * p.input + ((outputTok || 0) / 1_000_000) * p.output
}

async function sendWA(jid, text) {
  if (!jid) return
  const { sendWhatsApp } = await import('../gateway/evolution.js')
  await sendWhatsApp(jid, text).catch(() => {})
}

export async function runWeeklyReport() {
  const db = getDb()
  const since = Math.floor(Date.now() / 1000) - 7 * 86400
  const collabs = db.prepare(`SELECT id, display_name, username, token_budget_monthly FROM users WHERE role='collaborator' AND is_active=1`).all()
  if (!collabs.length) return

  const ownerJid = process.env.WHATSAPP_OWNER_JID
  const lines = ['📊 *Relatório semanal de colaboradores*\n']

  for (const u of collabs) {
    const reqs  = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE user_id=? AND created_at>?`).get(u.id, since)
    const msgs  = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(input_tokens),0) it, COALESCE(SUM(output_tokens),0) ot FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.user_id=? AND m.created_at>? AND m.role='assistant'`).get(u.id, since)
    const cost  = calcCost(msgs.it, msgs.ot)
    const lastR = db.prepare(`SELECT MAX(created_at) t FROM audit_log WHERE user_id=?`).get(u.id)
    const daysSince = lastR.t ? Math.floor((Date.now() / 1000 - lastR.t) / 86400) : 999
    const budgetLine = u.token_budget_monthly
      ? ` · orçamento ${Math.round(((msgs.it + msgs.ot) / u.token_budget_monthly) * 100)}%`
      : ''
    lines.push(`*${u.display_name || u.username}*\n  Requests: ${reqs.c} · Msgs: ${msgs.c} · Custo: $${cost.toFixed(3)}${budgetLine}\n  Última atividade: ${daysSince === 0 ? 'hoje' : daysSince === 999 ? 'nunca' : `${daysSince}d atrás`}`)
  }

  await sendWA(ownerJid, lines.join('\n'))
}

export async function checkInactivity() {
  const db = getDb()
  const ownerJid = process.env.WHATSAPP_OWNER_JID
  const threshold = 48 * 3600
  const now = Math.floor(Date.now() / 1000)
  const collabs = db.prepare(`SELECT id, display_name, username FROM users WHERE role='collaborator' AND is_active=1`).all()
  for (const u of collabs) {
    const last = db.prepare(`SELECT MAX(created_at) t FROM audit_log WHERE user_id=?`).get(u.id)
    if (!last.t || now - last.t > threshold) {
      const daysSince = last.t ? Math.round((now - last.t) / 3600) : null
      await sendWA(ownerJid, `⚠️ *Inatividade detectada*\n*${u.display_name || u.username}* não acessa há ${daysSince ? daysSince + 'h' : 'tempo indefinido'}.`)
    }
  }
}

export async function checkBudgets() {
  const db = getDb()
  const ownerJid = process.env.WHATSAPP_OWNER_JID
  const now = Math.floor(Date.now() / 1000)
  const collabs = db.prepare(`SELECT id, display_name, username, token_budget_monthly, tokens_this_month, budget_notified_at FROM users WHERE role='collaborator' AND is_active=1 AND token_budget_monthly IS NOT NULL AND token_budget_monthly > 0`).all()
  for (const u of collabs) {
    const used = u.tokens_this_month || 0
    const pct  = (used / u.token_budget_monthly) * 100
    if (pct >= 80 && (!u.budget_notified_at || now - u.budget_notified_at > 86400)) {
      await sendWA(ownerJid, `💰 *Budget tokens*\n*${u.display_name || u.username}* usou ${Math.round(pct)}% do orçamento mensal (${(used / 1000).toFixed(1)}k / ${(u.token_budget_monthly / 1000).toFixed(1)}k tokens).`)
      db.prepare(`UPDATE users SET budget_notified_at=? WHERE id=?`).run(now, u.id)
    }
  }
}

export function resetMonthlyTokens() {
  getDb().prepare(`UPDATE users SET tokens_this_month=0, budget_notified_at=NULL WHERE role='collaborator'`).run()
}

export function addTokenUsage(userId, inputTokens, outputTokens) {
  if (!userId) return
  const total = (inputTokens || 0) + (outputTokens || 0)
  if (!total) return
  try { getDb().prepare(`UPDATE users SET tokens_this_month=COALESCE(tokens_this_month,0)+? WHERE id=?`).run(total, userId) } catch {}
}
