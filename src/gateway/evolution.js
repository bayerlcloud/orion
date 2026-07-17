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

  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    null
  )
}

function isAudioMessage(body) {
  const msg = body?.data?.message
  return !!(msg?.audioMessage || msg?.pttMessage)
}

async function transcribeAudio(body) {
  const msgId = body?.data?.key?.id ?? Date.now()

  // 1. Baixar base64 do áudio via Evolution API
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

  // 2. Salvar como arquivo temp
  const tmpPath = join('/tmp', `orion_audio_${msgId}.ogg`)
  writeFileSync(tmpPath, Buffer.from(b64, 'base64'))

  // 3. Transcrever com faster-whisper local (modelo small em cache)
  try {
    const { stdout } = await execa('python3', [WHISPER_SCRIPT, tmpPath], { timeout: 120_000 })
    return stdout.trim()
  } finally {
    try { unlinkSync(tmpPath) } catch {}
  }
}

function extractJid(body) {
  return body?.data?.key?.remoteJid ?? null
}

function isFromOwner(jid) {
  if (!OWNER_JID) return true  // se não configurado, aceita tudo
  const clean = (s) => s?.replace('@s.whatsapp.net', '').replace(/^\+/, '')
  const ownerNum = clean(OWNER_JID)
  const msgNum = clean(jid)
  // aceita match exato ou com/sem código 55 na frente
  return msgNum === ownerNum || msgNum?.endsWith(ownerNum) || ownerNum?.endsWith(msgNum)
}

router.post('/evolution', async (req, res) => {
  res.sendStatus(200)  // responde imediatamente para o Evolution não reenviar

  const body = req.body
  const event = body?.event

  if (event !== 'messages.upsert') return

  const jid = extractJid(body)
  const text = extractMessage(body)

  if (!jid) return
  if (!isFromOwner(jid)) return
  if (body?.data?.key?.fromMe) return  // ignora mensagens que o próprio bot enviou

  // ── Turn context hook (Round 4, item 5) ─────────────────────────────────────
  emitTurnStart({
    message:  text ?? '[audio]',
    platform: 'whatsapp',
    model:    process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    jid,
  })

  // Transcrever áudio se necessário
  let finalText = text
  let isAudio = false
  if (!text && isAudioMessage(body)) {
    try {
      const transcript = await transcribeAudio(body)
      if (transcript) {
        finalText = `🎵 [áudio]: ${transcript}`
        isAudio = true
        log.info(`[evolution] áudio transcrito: ${transcript.slice(0, 80)}`)
      }
    } catch (e) {
      log.error('[evolution] falha ao transcrever áudio:', e.message)
      return
    }
  }

  if (!finalText) return

  log.info(`[evolution] ${jid}: ${finalText.slice(0, 80)}`)

  // Broadcast para web chat (WhatsApp → web)
  emitOrionEvent('user_message', { content: finalText, source: 'whatsapp', ts: Date.now() })
  emitOrionEvent('typing', { on: true })
  _lastInbound.set(jid, Date.now())

  // Keep-alive silencioso — só dispara se demorar mais de 45s (conversa normal nunca chega aqui)
  const keepAlive = setTimeout(async () => {
    await sendWhatsApp(jid, '⏳ Processando, aguarde...').catch(() => {})
  }, 45_000)

  try {
    // ── H4: Skill slash commands ──────────────────────────────────────────────
    // /skills — lista skills disponíveis | /skill <nome> — carrega conteúdo
    const lower = finalText.toLowerCase().trim()
    if (lower === '/skills') {
      clearTimeout(keepAlive)
      try {
        const { getDb } = await import('../db/index.js')
        const rows = getDb().prepare(
          `SELECT name, description FROM skills WHERE status != 'archived' ORDER BY usage_count DESC LIMIT 30`
        ).all()
        const list = rows.length
          ? rows.map(s => `• */skill ${s.name}*${s.description ? ` — ${s.description.slice(0, 60)}` : ''}`).join('\n')
          : '_Nenhuma skill ainda._'
        await sendWhatsApp(jid, `🧩 *Skills disponíveis:*\n\n${list}`)
      } catch (e) {
        await sendWhatsApp(jid, `❌ Erro ao listar skills: ${e.message}`)
      }
      return
    }
    if (lower.startsWith('/skill ')) {
      const skillName = finalText.slice(7).trim()
      try {
        const { getDb } = await import('../db/index.js')
        const skill = getDb().prepare(
          `SELECT name, content FROM skills WHERE name = ? AND status != 'archived'`
        ).get(skillName)
        if (skill) {
          // Incrementa uso e injeta o conteúdo da skill como contexto da próxima resposta
          getDb().prepare(`UPDATE skills SET usage_count = usage_count + 1, last_used_at = unixepoch() WHERE name = ?`).run(skillName)
          finalText = `[Skill ativada: ${skill.name}]\n${skill.content}\n\nAplique esta skill ao contexto atual.`
        } else {
          clearTimeout(keepAlive)
          await sendWhatsApp(jid, `❓ Skill "${skillName}" não encontrada. Use /skills para ver as disponíveis.`)
          return
        }
      } catch (e) {
        clearTimeout(keepAlive)
        await sendWhatsApp(jid, `❌ Erro: ${e.message}`)
        return
      }
    }

    // ── Aprovações bloqueantes: "sim"/"não" resolve a pendente mais recente ─────
    try {
      const { tryAnswerFromWhatsApp } = await import('../api/approvals.js')
      const approvalReply = tryAnswerFromWhatsApp(finalText)
      if (approvalReply) {
        clearTimeout(keepAlive)
        emitOrionEvent('typing', { on: false })
        await sendWhatsApp(jid, approvalReply)
        return
      }
    } catch {}

    // ── U3: Votação de deduplicação (resposta A/B/M/X a pergunta pendente) ──────
    if (/^[abmx]$/i.test(lower)) {
      try {
        const { getDb } = await import('../db/index.js')
        const pending = getDb().prepare(
          `SELECT id FROM dedup_queue WHERE resolved = 0 AND question_sent_at IS NOT NULL ORDER BY question_sent_at DESC LIMIT 1`
        ).get()
        if (pending) {
          clearTimeout(keepAlive)
          const { resolveDedupVote, sendNextDedupQuestion } = await import('../memory/memory-dedup.js')
          const result = resolveDedupVote(pending.id, lower)
          await sendWhatsApp(jid, result.ok ? `✅ Voto "${lower.toUpperCase()}" registrado.` : `❌ ${result.error}`)
          // Envia próxima pergunta se houver
          setTimeout(() => sendNextDedupQuestion().catch(() => {}), 1500)
          return
        }
      } catch {}
      // se não havia dedup pendente, segue o fluxo normal (pode ser msg legítima)
    }

    // /multi — missão paralela (decompõe em subtarefas independentes)
    if (finalText.toLowerCase().startsWith('/multi ')) {
      const goal = finalText.slice(7).trim()
      if (goal.length > 5) {
        clearTimeout(keepAlive)
        await sendWhatsApp(jid, '🚀 Criando missão... vou avisar quando terminar.').catch(() => {})
        createAndExecuteMission(goal, { source: 'whatsapp' }).catch(err =>
          sendWhatsApp(jid, `❌ Missão falhou: ${err.message}`).catch(() => {})
        )
        return
      }
    }

    // /agente — orquestração em loop (pensa, age, itera até concluir)
    if (finalText.toLowerCase().startsWith('/agente ')) {
      const goal = finalText.slice(8).trim()
      if (goal.length > 5) {
        clearTimeout(keepAlive)
        await sendWhatsApp(jid, '🤖 Agente em loop iniciado... vou avisar quando terminar.').catch(() => {})
        const { id } = await createOrchestration(goal, { source: 'whatsapp' })
        // notifica resultado quando terminar
        waitOrchestrationAndNotify(id, jid, goal).catch(() => {})
        return
      }
    }

    const reply = await runOrion({ jid, message: finalText, channel: 'whatsapp' })
    clearTimeout(keepAlive)
    emitOrionEvent('typing', { on: false })
    if (reply) {
      // Broadcast resposta para web chat
      emitOrionEvent('assistant_message', { content: reply, ts: Date.now() })
      try {
        await sendWhatsApp(jid, reply)
      } catch (sendErr) {
        // Falha SÓ no envio (ex: 400 por formato) — loga, não re-notifica o usuário
        log.error({ err: sendErr.message }, '[evolution] falha ao enviar resposta')
      }
    }
  } catch (err) {
    clearTimeout(keepAlive)
    log.error({ err: err.message }, '[evolution] Erro ao processar mensagem')
    // Mensagem amigável (sem detalhe técnico cru)
    await sendWhatsApp(jid, '❌ Tive um problema ao processar. Pode repetir?').catch(() => {})
  }
})

const WA_MAX_CHARS = 3500  // WhatsApp/Evolution rejeita (400) textos muito longos

async function sendOne(jid, text) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: jid, text }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 200) } catch {}
    throw new Error(`Evolution send error: ${res.status} ${detail}`)
  }
}

/** Quebra texto longo em pedaços respeitando parágrafos/linhas. */
function chunkText(text, max = WA_MAX_CHARS) {
  if (text.length <= max) return [text]
  const chunks = []
  let buf = ''
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > max) {
      if (buf) chunks.push(buf)
      // linha individual maior que o limite → fatia bruta
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
        buf = ''
      } else {
        buf = line
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

// Última mensagem RECEBIDA por jid — usada pra distinguir reply direta de envio
// proativo no modo silencioso (reply passa; proativo entra na fila).
const _lastInbound = new Map()
const _silentQueue = []
const SILENT_QUEUE_MAX = 20
const REPLY_WINDOW_MS = 5 * 60_000

export async function sendWhatsApp(jid, text) {
  const clean = String(text ?? '').trim()
  if (!clean) return  // não envia mensagem vazia (causa 400)

  const isReply = Date.now() - (_lastInbound.get(jid) ?? 0) < REPLY_WINDOW_MS
  if (isSilentMode() && !isReply) {
    if (_silentQueue.length < SILENT_QUEUE_MAX) _silentQueue.push({ jid, text: clean })
    emitOrionEvent('system_event', { text: `🔕 Silenciado (WA): ${clean.slice(0, 70)}`, ts: Date.now() })
    return
  }

  const parts = chunkText(clean)
  for (const part of parts) {
    await sendOne(jid, part)
  }
}

/** Entrega as mensagens enfileiradas durante o modo silencioso. */
export async function flushSilentQueue() {
  if (!_silentQueue.length) return 0
  const items = _silentQueue.splice(0)
  const header = `🔕→🔔 *${items.length} notificação(ões) do período silencioso:*`
  const byJid = new Map()
  for (const it of items) {
    if (!byJid.has(it.jid)) byJid.set(it.jid, [])
    byJid.get(it.jid).push(it.text)
  }
  for (const [jid, texts] of byJid) {
    await sendWhatsApp(jid, `${header}\n\n${texts.join('\n\n---\n\n')}`).catch(() => {})
  }
  return items.length
}

async function waitOrchestrationAndNotify(orchId, jid, goal) {
  const { getOrchestration } = await import('../agent/orchestrator-loop.js')
  const POLL_MS = 15_000
  const MAX_WAIT = 50 * 60 * 1000 // 50 min
  const start = Date.now()
  while (Date.now() - start < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_MS))
    const o = getOrchestration(orchId)
    if (!o || o.status === 'running') continue
    if (o.status === 'done') {
      const preview = (o.result ?? '').slice(0, 3000)
      await sendWhatsApp(jid, `✅ *Agente concluído*\n*Objetivo:* ${goal}\n\n${preview}`).catch(() => {})
    } else {
      await sendWhatsApp(jid, `❌ *Agente falhou*\n*Objetivo:* ${goal}\n${o.error ?? ''}`).catch(() => {})
    }
    return
  }
  await sendWhatsApp(jid, `⏰ *Agente: timeout de 50min*\n*Objetivo:* ${goal}`).catch(() => {})
}
