import { Router } from 'express'
import { writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { runOrion } from '../agent/orion.js'
import { createAndExecuteMission } from '../agent/mission.js'
import { createOrchestration } from '../agent/orchestrator-loop.js'
import { emitTurnStart } from '../memory/turn-context.js'
import { emitOrionEvent, isSilentMode } from '../api/orion-stream.js'
import { createLogger } from '../logger.js'
const log = createLogger('evolution')

const __dirname = dirname(fileURLToPath(import.meta.url))
const WHISPER_SCRIPT = join(__dirname, 'whisper_transcribe.py')

export const router = Router()

const OWNER_JID = process.env.WHATSAPP_OWNER_JID ?? ''

function extractMessage(body) {
  const msg = body?.data?.message
  if (!msg) return null
  return msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? null
}

function isAudioMessage(body) {
  const msg = body?.data?.message
  return !!(msg?.audioMessage || msg?.pttMessage)
}

async function transcribeAudio(body) {
  const msgId = body?.data?.key?.id ?? Date.now()
  const mediaUrl = `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE}`
  const mediaRes = await fetch(mediaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ message: { key: body.data.key, message: body.data.message } }),
  })
  if (!mediaRes.ok) throw new Error(`Evolution media ${mediaRes.status}`)
  const mediaData = await mediaRes.json()
  const b64 = mediaData.base64
  if (!b64) throw new Error('base64 vazio')
  const tmpPath = join('/tmp', `orion_audio_${msgId}.ogg`)
  writeFileSync(tmpPath, Buffer.from(b64, 'base64'))
  try {
    const { stdout } = await execa('python3', [WHISPER_SCRIPT, tmpPath], { timeout: 120_000 })
    return stdout.trim()
  } finally {
    try { unlinkSync(tmpPath) } catch {}
  }
}

function extractJid(body) { return body?.data?.key?.remoteJid ?? null }

function isFromOwner(jid) {
  if (!OWNER_JID) return true
  const clean = (s) => s?.replace('@s.whatsapp.net', '').replace(/^\+/, '')
  const ownerNum = clean(OWNER_JID)
  const msgNum = clean(jid)
  return msgNum === ownerNum || msgNum?.endsWith(ownerNum) || ownerNum?.endsWith(msgNum)
}

router.post('/evolution', async (req, res) => {
  res.sendStatus(200)
  const body = req.body
  if (body?.event !== 'messages.upsert') return
  const jid = extractJid(body)
  const text = extractMessage(body)
  if (!jid || !isFromOwner(jid) || body?.data?.key?.fromMe) return

  emitTurnStart({ message: text ?? '[audio]', platform: 'whatsapp', model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6', jid })

  let finalText = text
  if (!text && isAudioMessage(body)) {
    try {
      const transcript = await transcribeAudio(body)
      if (transcript) { finalText = `🎵 [audio]: ${transcript}`; log.info(`[evolution] audio transcrito: ${transcript.slice(0, 80)}`) }
    } catch (e) { log.error('[evolution] falha ao transcrever audio:', e.message); return }
  }
  if (!finalText) return

  log.info(`[evolution] ${jid}: ${finalText.slice(0, 80)}`)
  emitOrionEvent('user_message', { content: finalText, source: 'whatsapp', ts: Date.now() })
  emitOrionEvent('typing', { on: true })
  _lastInbound.set(jid, Date.now())

  const keepAlive = setTimeout(async () => { await sendWhatsApp(jid, '⏳ Processando, aguarde...').catch(() => {}) }, 45_000)

  try {
    const lower = finalText.toLowerCase().trim()

    if (lower === '/skills') {
      clearTimeout(keepAlive)
      const { getDb } = await import('../db/index.js')
      const rows = getDb().prepare(`SELECT name, description FROM skills WHERE status != 'archived' ORDER BY usage_count DESC LIMIT 30`).all()
      const list = rows.length ? rows.map(s => `• */skill ${s.name}*${s.description ? ` — ${s.description.slice(0, 60)}` : ''}`).join('\n') : '_Nenhuma skill ainda._'
      await sendWhatsApp(jid, `🧩 *Skills disponíveis:*\n\n${list}`)
      return
    }

    if (lower.startsWith('/skill ')) {
      const skillName = finalText.slice(7).trim()
      const { getDb } = await import('../db/index.js')
      const skill = getDb().prepare(`SELECT name, content FROM skills WHERE name = ? AND status != 'archived'`).get(skillName)
      if (skill) {
        getDb().prepare(`UPDATE skills SET usage_count = usage_count + 1, last_used_at = unixepoch() WHERE name = ?`).run(skillName)
        finalText = `[Skill ativada: ${skill.name}]\n${skill.content}\n\nAplique esta skill ao contexto atual.`
      } else {
        clearTimeout(keepAlive)
        await sendWhatsApp(jid, `❓ Skill "${skillName}" não encontrada.`)
        return
      }
    }

    try {
      const { tryAnswerFromWhatsApp } = await import('../api/approvals.js')
      const approvalReply = tryAnswerFromWhatsApp(finalText)
      if (approvalReply) { clearTimeout(keepAlive); emitOrionEvent('typing', { on: false }); await sendWhatsApp(jid, approvalReply); return }
    } catch {}

    if (/^[abmx]$/i.test(lower)) {
      const { getDb } = await import('../db/index.js')
      const pending = getDb().prepare(`SELECT id FROM dedup_queue WHERE resolved = 0 AND question_sent_at IS NOT NULL ORDER BY question_sent_at DESC LIMIT 1`).get()
      if (pending) {
        clearTimeout(keepAlive)
        const { resolveDedupVote, sendNextDedupQuestion } = await import('../memory/memory-dedup.js')
        const result = resolveDedupVote(pending.id, lower)
        await sendWhatsApp(jid, result.ok ? `✅ Voto "${lower.toUpperCase()}" registrado.` : `❌ ${result.error}`)
        setTimeout(() => sendNextDedupQuestion().catch(() => {}), 1500)
        return
      }
    }

    if (finalText.toLowerCase().startsWith('/multi ')) {
      const goal = finalText.slice(7).trim()
      if (goal.length > 5) {
        clearTimeout(keepAlive)
        await sendWhatsApp(jid, '🚀 Criando missão...').catch(() => {})
        createAndExecuteMission(goal, { source: 'whatsapp' }).catch(err => sendWhatsApp(jid, `❌ Missão falhou: ${err.message}`).catch(() => {}))
        return
      }
    }

    if (finalText.toLowerCase().startsWith('/agente ')) {
      const goal = finalText.slice(8).trim()
      if (goal.length > 5) {
        clearTimeout(keepAlive)
        await sendWhatsApp(jid, '🤖 Agente em loop iniciado...').catch(() => {})
        const { id } = await createOrchestration(goal, { source: 'whatsapp' })
        waitOrchestrationAndNotify(id, jid, goal).catch(() => {})
        return
      }
    }

    const reply = await runOrion({ jid, message: finalText, channel: 'whatsapp' })
    clearTimeout(keepAlive)
    emitOrionEvent('typing', { on: false })
    if (reply) {
      emitOrionEvent('assistant_message', { content: reply, ts: Date.now() })
      try { await sendWhatsApp(jid, reply) } catch (sendErr) { log.error({ err: sendErr.message }, '[evolution] falha ao enviar') }
    }
  } catch (err) {
    clearTimeout(keepAlive)
    log.error({ err: err.message }, '[evolution] erro')
    await sendWhatsApp(jid, '❌ Tive um problema ao processar. Pode repetir?').catch(() => {})
  }
})

const WA_MAX_CHARS = 3500
const _lastInbound = new Map()
const _silentQueue = []
const SILENT_QUEUE_MAX = 20
const REPLY_WINDOW_MS = 5 * 60_000

async function sendOne(jid, text) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.EVOLUTION_API_KEY }, body: JSON.stringify({ number: jid, text }) })
  if (!res.ok) { let d = ''; try { d = (await res.text()).slice(0, 200) } catch {}; throw new Error(`Evolution ${res.status} ${d}`) }
}

function chunkText(text, max = WA_MAX_CHARS) {
  if (text.length <= max) return [text]
  const chunks = []; let buf = ''
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > max) {
      if (buf) chunks.push(buf)
      if (line.length > max) { for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max)); buf = '' } else { buf = line }
    } else { buf = buf ? `${buf}\n${line}` : line }
  }
  if (buf) chunks.push(buf)
  return chunks
}

export async function sendWhatsApp(jid, text) {
  const clean = String(text ?? '').trim()
  if (!clean) return
  const isReply = Date.now() - (_lastInbound.get(jid) ?? 0) < REPLY_WINDOW_MS
  if (isSilentMode() && !isReply) {
    if (_silentQueue.length < SILENT_QUEUE_MAX) _silentQueue.push({ jid, text: clean })
    emitOrionEvent('system_event', { text: `🔕 Silenciado: ${clean.slice(0, 70)}`, ts: Date.now() })
    return
  }
  for (const part of chunkText(clean)) await sendOne(jid, part)
}

export async function flushSilentQueue() {
  if (!_silentQueue.length) return 0
  const items = _silentQueue.splice(0)
  const byJid = new Map()
  for (const it of items) { if (!byJid.has(it.jid)) byJid.set(it.jid, []); byJid.get(it.jid).push(it.text) }
  for (const [jid, texts] of byJid) await sendWhatsApp(jid, `🔕→🔔 *${items.length} notificações do modo silencioso:*\n\n${texts.join('\n\n---\n\n')}`).catch(() => {})
  return items.length
}

async function waitOrchestrationAndNotify(orchId, jid, goal) {
  const { getOrchestration } = await import('../agent/orchestrator-loop.js')
  const start = Date.now()
  while (Date.now() - start < 50 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 15_000))
    const o = getOrchestration(orchId)
    if (!o || o.status === 'running') continue
    if (o.status === 'done') await sendWhatsApp(jid, `✅ *Agente concluído*\n*Objetivo:* ${goal}\n\n${(o.result ?? '').slice(0, 3000)}`).catch(() => {})
    else await sendWhatsApp(jid, `❌ *Agente falhou*\n${o.error ?? ''}`).catch(() => {})
    return
  }
  await sendWhatsApp(jid, `⏰ *Agente: timeout*\n*Objetivo:* ${goal}`).catch(() => {})
}
