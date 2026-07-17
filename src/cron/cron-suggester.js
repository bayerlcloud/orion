/**
 * Cron Suggester (H5) — após cada sessão, Haiku sugere cron jobs úteis.
 *
 * Analisa o conteúdo da conversa e propõe automações proativas.
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { sendWhatsApp } from '../gateway/evolution.js'
import { createLogger } from '../logger.js'
const log = createLogger('cron-suggester')

export async function suggestCronJobs(sessionId, conversationSummary) {
  if (!conversationSummary || conversationSummary.length < 50) return []

  try {
    const db = getDb()

    const existing = db.prepare(`SELECT name FROM cron_jobs WHERE status != 'deleted'`).all().map(r => r.name)
    const BLUEPRINT_CATALOG = [
      { name: 'daily-standup',    schedule: '0 9 * * 1-5' },
      { name: 'weekly-review',    schedule: '0 18 * * 5'  },
      { name: 'skill-audit',      schedule: '0 10 * * 0'  },
      { name: 'memory-health',    schedule: '0 3 1 * *'   },
      { name: 'project-checkin',  schedule: '0 17 * * 3'  },
    ]
    const availableBlueprints = BLUEPRINT_CATALOG
      .filter(b => !existing.includes(b.name))
      .map(b => `"${b.name}" (${b.schedule})`)
      .join(', ')

    const prompt = `Analise esta conversa e sugira 0 a 2 cron jobs que ajudariam no futuro.

Conversa:
${conversationSummary.slice(0, 1200)}

Blueprints disponíveis: ${availableBlueprints || 'nenhum novo blueprint disponível'}

Retorne JSON:
{
  "suggestions": [
    {
      "name": "nome-kebab-case",
      "schedule": "expressão cron (ex: 0 9 * * 1)",
      "task": "o que o agente deve fazer",
      "rationale": "por que seria útil baseado na conversa"
    }
  ]
}

Só sugira se houver padrão CLARO na conversa. Se não houver, retorne {"suggestions": []}.
Máximo 2 sugestões. Nomes concisos, tarefas em português.`

    const r = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000 })

    const raw = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    const parsed = JSON.parse(raw)
    const suggestions = (parsed.suggestions ?? []).slice(0, 2)

    if (suggestions.length === 0) return []

    const insert = db.prepare(`
      INSERT INTO cron_suggestions (name, schedule, task_prompt, rationale, source_session_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        rationale = excluded.rationale,
        source_session_id = excluded.source_session_id,
        created_at = unixepoch()
    `)

    for (const s of suggestions) {
      if (!s.name || !s.schedule || !s.task) continue
      try {
        insert.run(s.name, s.schedule, s.task, s.rationale ?? '', sessionId)
        log.info({ name: s.name, schedule: s.schedule }, '[cron-suggester] sugestão salva')
      } catch {}
    }

    const owner = process.env.WHATSAPP_OWNER_JID
    if (owner && suggestions.length > 0) {
      const lines = suggestions.map(s =>
        `• *${s.name}* (${s.schedule})\n  ${s.task.slice(0, 80)}\n  _${s.rationale?.slice(0, 80) ?? ''}_`
      ).join('\n\n')
      await sendWhatsApp(owner,
        `💡 *Sugestões de cron jobs* (baseadas na conversa):\n\n${lines}\n\nUse /api/cron/suggestions para ver e ativar.`
      ).catch(() => {})
    }

    return suggestions
  } catch (err) {
    log.debug({ err: err.message }, '[cron-suggester] erro silencioso')
    return []
  }
}

export function listCronSuggestions(limit = 10) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT * FROM cron_suggestions WHERE activated = 0 ORDER BY created_at DESC LIMIT ?
    `).all(limit)
  } catch { return [] }
}

export function activateSuggestion(name) {
  const db = getDb()
  try {
    const s = db.prepare(`SELECT * FROM cron_suggestions WHERE name = ?`).get(name)
    if (!s) return { ok: false, error: 'sugestão não encontrada' }
    db.prepare(`
      INSERT INTO cron_jobs (name, schedule, task_prompt, status)
      VALUES (?, ?, ?, 'active')
      ON CONFLICT(name) DO UPDATE SET schedule = excluded.schedule, task_prompt = excluded.task_prompt, status = 'active'
    `).run(s.name, s.schedule, s.task_prompt)
    db.prepare(`UPDATE cron_suggestions SET activated = 1, activated_at = unixepoch() WHERE name = ?`).run(name)
    log.info({ name }, '[cron-suggester] sugestão ativada')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
