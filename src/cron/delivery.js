/**
 * Delivery Router — entrega de resultados de cron jobs em múltiplas plataformas.
 * Suporte: whatsapp, telegram, webhook, local (arquivo), all, origin
 */

import { sendWhatsApp } from '../gateway/evolution.js'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { logger } from '../logger.js'

const OUTPUT_DIR = path.resolve('/config/workspace/orion/data/cron-output')

// ── Resolve deliver string → array de targets concretos ───────────────────────

export function resolveTargets(deliver = 'whatsapp', origin = null) {
  const parts = deliver.split(',').map(s => s.trim()).filter(Boolean)
  const targets = []

  for (const part of parts) {
    const lower = part.toLowerCase()

    if (lower === 'all') {
      if (process.env.WHATSAPP_OWNER_JID)
        targets.push({ platform: 'whatsapp', jid: process.env.WHATSAPP_OWNER_JID })
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
        targets.push({ platform: 'telegram', chatId: process.env.TELEGRAM_CHAT_ID })
      if (process.env.WEBHOOK_CRON_URL)
        targets.push({ platform: 'webhook', url: process.env.WEBHOOK_CRON_URL })
      continue
    }

    if (lower === 'origin') {
      if (!origin) continue
      if (origin.platform === 'whatsapp' && origin.jid)
        targets.push({ platform: 'whatsapp', jid: origin.jid })
      else if (origin.platform === 'telegram' && origin.chatId)
        targets.push({ platform: 'telegram', chatId: origin.chatId, threadId: origin.threadId })
      else if (origin.platform === 'webhook' && origin.url)
        targets.push({ platform: 'webhook', url: origin.url })
      continue
    }

    if (lower === 'local') {
      targets.push({ platform: 'local' })
      continue
    }

    if (lower === 'whatsapp' || lower.startsWith('whatsapp:')) {
      const jid = lower.startsWith('whatsapp:')
        ? part.slice(9)
        : process.env.WHATSAPP_OWNER_JID
      if (jid) targets.push({ platform: 'whatsapp', jid })
      continue
    }

    if (lower === 'telegram' || lower.startsWith('telegram:')) {
      const segments = part.split(':')
      const chatId = segments[1] ?? process.env.TELEGRAM_CHAT_ID
      const threadId = segments[2] ?? null
      if (chatId) targets.push({ platform: 'telegram', chatId, threadId })
      continue
    }

    if (lower === 'webhook' || lower.startsWith('webhook:')) {
      const url = part.startsWith('webhook:') ? part.slice(8) : process.env.WEBHOOK_CRON_URL
      if (url) targets.push({ platform: 'webhook', url })
      continue
    }
  }

  // Deduplica por chave canônica
  const seen = new Set()
  return targets.filter(t => {
    const key = JSON.stringify(t)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Entrega para todos os targets ─────────────────────────────────────────────

export async function deliverResult(targets, jobName, jobId, output) {
  if (!targets || targets.length === 0) return null

  const errors = []
  for (const target of targets) {
    try {
      await _deliverToTarget(target, jobName, jobId, output)
    } catch (err) {
      logger.error({ err, target: target.platform, jobId }, 'falha de entrega')
      errors.push(`${target.platform}: ${err.message}`)
    }
  }

  return errors.length ? errors.join('; ') : null
}

// ── Adaptadores por plataforma ────────────────────────────────────────────────

async function _deliverToTarget(target, jobName, jobId, output) {
  const msg = _wrapMessage(jobName, output)

  switch (target.platform) {
    case 'whatsapp':
      await sendWhatsApp(target.jid, msg)
      break

    case 'telegram':
      await _sendTelegram(target.chatId, msg, target.threadId)
      break

    case 'webhook':
      await _sendWebhook(target.url, { jobName, jobId, output, timestamp: new Date().toISOString() })
      break

    case 'local':
      await _saveLocal(jobId, jobName, output)
      break

    default:
      logger.warn({ platform: target.platform }, 'plataforma desconhecida, ignorando')
  }
}

function _wrapMessage(jobName, output) {
  return `⏰ *${jobName}*\n\n${output}`
}

async function _sendTelegram(chatId, text, threadId) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado')
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID não configurado')

  const body = { chat_id: chatId, text, parse_mode: 'Markdown' }
  if (threadId) body.message_thread_id = parseInt(threadId, 10)

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Telegram ${res.status}: ${err.slice(0, 200)}`)
  }
}

async function _sendWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Webhook ${res.status}`)
}

async function _saveLocal(jobId, jobName, output) {
  const dir = path.join(OUTPUT_DIR, jobId)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const content = `# Cron Job: ${jobName}\nExecutado: ${new Date().toISOString()}\n\n## Resposta\n\n${output}\n`
  await writeFile(path.join(dir, `${ts}.md`), content, 'utf8')
}
