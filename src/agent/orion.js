import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { getProactiveMemories, processExchange, createSessionSnapshot, feedbackMemory } from '../memory/index.js'
import { compressSessionIfNeeded } from '../memory/compressor.js'
import { SYSTEM_PROMPT, buildMemoryContext } from './prompt.js'
import { generateSkillIfWorthy } from './skill-generator.js'
import { updateUserProfile } from './user-profile.js'
import { buildFullContext, serializeContext } from '../api/context.js'
import { listSessions } from '../sessions/indexer.js'
import { parseSession } from '../sessions/reader.js'
import { getOrCreate, updateClaudeSessionId as updateRegistrySessionId, projectSessionName } from '../sessions/registry.js'

import { createLogger } from '../logger.js'
import { logCall } from '../insights/index.js'
const log = createLogger('orion')

// ── Trivialidade ──────────────────────────────────────────────────────────────
// Saudações curtas = triviais (resposta rápida e conversacional), MESMO com "?"
// ("tudo bem?", "e aí, beleza?"). Pergunta/pedido de verdade NÃO é trivial.
// Normaliza acentos para evitar problemas de \b com í/á/etc.
const GREETING_PREFIXES = [
  'oi', 'ola', 'fala', 'fal ', 'eai', 'e ai', 'ai ', 'opa', 'hey', 'hello', 'alo',
  'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo certo', 'tudo joia',
  'como vai', 'blz', 'beleza', 'salve', 'valeu', 'obrigad', 'vlw', 'teste', 'test',
]
// Sem \b no fim: casa stems ("mostr"→"mostra", "bug"→"bugs", "cri"→"cria")
const SUBSTANTIVE_RE = /\b(qual|quais|quant|quando|onde|porqu|status|deploy|erro|bug|implement|config|instal|cria|faz|mostr|lista|explica|resolv|consert|arrum|atualiz|deslig|mand|envi|sobe|precis|quero|pode)/
function isTrivialMessage(m) {
  const raw = String(m ?? '').trim()
  if (raw.length <= 3) return true
  const t = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const startsGreeting = GREETING_PREFIXES.some(g => t.startsWith(g))
  if (!startsGreeting) return false   // não começa com saudação → não é trivial
  if (t.length >= 40) return false     // longo → provavelmente tem conteúdo
  if (SUBSTANTIVE_RE.test(t)) return false  // tem pergunta/pedido de verdade
  return true                          // saudação curta (com ou sem "tudo bem?")
}

// ── Mode indicator ────────────────────────────────────────────────────────────

function getModeIndicator(claudeSessionId, bridgeMode = false) {
  if (!claudeSessionId) return '*Orion*'

  let sessionName = null
  try {
    const db = getDb()
    const cs = db.prepare(
      'SELECT custom_title, ai_title FROM claude_sessions WHERE id = ?'
    ).get(claudeSessionId)
    sessionName = cs?.custom_title ?? cs?.ai_title ?? null
  } catch {}

  // Ignora títulos poluídos (tags, quebras de linha, longos demais)
  if (sessionName && (/[<\n>]/.test(sessionName) || sessionName.length > 40)) {
    sessionName = null
  }

  if (!sessionName) return '*Orion*'

  return bridgeMode ? `*Claude - ${sessionName}*` : `*Orion - ${sessionName}*`
}

// ── Snapshot de sessões Claude Code (injetado no contexto) ───────────────────

async function buildSessionsSnapshot() {
  try {
    const sessions = listSessions({ limit: 100 })
    const active  = sessions.filter(s => s.status === 'active')
    const paused  = sessions.filter(s => s.status === 'paused')

    const lines = [`<sessoes_claude_code>`]
    lines.push(`Ativas (${active.length}):`)
    if (active.length === 0) {
      lines.push('  nenhuma')
    } else {
      for (const s of active) {
        const name = s.custom_title ?? s.ai_title ?? s.first_user_msg?.slice(0, 40) ?? s.id.slice(0, 8)
        // Detectar Working vs Aguardando pelo último role no .jsonl
        let estado = 'Aguardando'
        try {
          const { messages } = await parseSession(s.path)
          const last = messages.filter(m => m.role === 'user' || m.role === 'assistant').at(-1)
          if (last?.role === 'user') estado = 'Working'
        } catch {}
        lines.push(`  - ${name} (${estado})`)
      }
    }
    lines.push(`Pausadas: ${paused.length}`)
    lines.push(`</sessoes_claude_code>`)
    return '\n\n' + lines.join('\n')
  } catch {
    return ''
  }
}

// Sessões ativas: jid → { sessionId, claudeSessionId }
const activeSessions = new Map()

// ── Feedback implícito de memória ─────────────────────────────────────────────
const _lastInjectedMems = new Map()  // session.id → [memory ids]
const CORRECTION_RE = /^(n[ãa]o[,.!\s]|errado|n[ãa]o [ée] (isso|assim)|na verdade|corrig|(es)?t[áa] errado|nada a ver)/i
const AFFIRMATION_RE = /^(exato|isso mesmo|isso a[íi]|perfeito|correto|certinho|[ée] isso)/i

function applyImplicitFeedback(sessionId, userMessage) {
  const ids = _lastInjectedMems.get(sessionId)
  if (!ids?.length) return
  const t = String(userMessage).trim()
  let verdict = null
  if (CORRECTION_RE.test(t)) verdict = false
  else if (AFFIRMATION_RE.test(t)) verdict = true
  if (verdict === null) return
  for (const mid of ids) { try { feedbackMemory(mid, verdict) } catch {} }
  _lastInjectedMems.delete(sessionId)  // nota dada uma vez só
  log.info({ sessionId, n: ids.length, verdict }, '[memoria] feedback implícito aplicado')
}

function getOrCreateSession(jid, channel = 'whatsapp') {
  const db = getDb()
  let session = db.prepare(`
    SELECT * FROM sessions WHERE jid = ? AND channel = ? ORDER BY last_active DESC LIMIT 1
  `).get(jid, channel)

  if (!session) {
    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO sessions (id, channel, jid) VALUES (?, ?, ?)
    `).run(id, channel, jid)
    session = { id, channel, jid, claude_session_id: null }
  }

  return session
}

function saveMessage(sessionId, role, content, channel) {
  const db = getDb()
  db.prepare(`
    INSERT INTO messages (session_id, role, content, channel) VALUES (?, ?, ?, ?)
  `).run(sessionId, role, content, channel)
  db.prepare(`
    UPDATE sessions SET message_count = message_count + 1, last_active = unixepoch() WHERE id = ?
  `).run(sessionId)
}

function updateClaudeSessionId(sessionId, claudeSessionId) {
  getDb().prepare(`
    UPDATE sessions SET claude_session_id = ? WHERE id = ?
  `).run(claudeSessionId, sessionId)
}

export async function runOrion({ jid, message, channel = 'whatsapp', sessionChannel = null }) {
  const _startMs = Date.now()
  const session = getOrCreateSession(jid, sessionChannel || channel)

  // U5: snapshot do estado de memórias no início da sessão (idempotente, background)
  setImmediate(() => { try { createSessionSnapshot(session.id) } catch {} })

  // ── Caminho LEVE para mensagens triviais (saudações etc.) ──────────────────
  const trivial = isTrivialMessage(message)

  // Comprimir contexto da sessão se necessário (pula no caminho leve)
  const contextSummary = trivial ? null : await compressSessionIfNeeded(session.id)

  // Contexto completo via pipeline unificado
  const isCasual = trivial || message.trim().length < 25
  const [fullCtx, proactive] = await Promise.all([
    isCasual ? Promise.resolve(null) : buildFullContext(message, { limit: 6 }),
    Promise.resolve(isCasual ? [] : getProactiveMemories(message)),
  ])

  // Feedback implícito: avalia ANTES de sobrescrever o rastro
  applyImplicitFeedback(session.id, message)
  const injectedIds = (fullCtx?.memories ?? []).map(m => m.id).filter(Boolean)
  if (injectedIds.length) _lastInjectedMems.set(session.id, injectedIds)

  const ctxStr = fullCtx ? serializeContext(fullCtx) : ''
  const proactiveStr = proactive.length
    ? '\n\n<memoria_proativa>\n' + proactive.map(m => m.content).join('\n') + '\n</memoria_proativa>'
    : ''

  const summarySection = contextSummary
    ? `\n\n<resumo_sessao>\n${contextSummary}\n</resumo_sessao>`
    : ''

  const sessionsSnapshot = trivial ? '' : await buildSessionsSnapshot()
  const augmentedMessage = trivial ? message : (message + summarySection + ctxStr + proactiveStr + sessionsSnapshot)

  // Salvar user message
  saveMessage(session.id, 'user', message, channel)

  // Session Registry — garante nome visível no sidebar para canal whatsapp
  let registryEntry = null
  if (channel === 'whatsapp') {
    const project = fullCtx?.projectSlug ?? null
    const sessionLabel = project ? projectSessionName(project) : 'Conversa: WhatsApp'
    registryEntry = getOrCreate(sessionLabel, { project, role: 'executor' })
  }

  const resumeId = trivial ? null : (registryEntry?.claude_session_id ?? session.claude_session_id)

  const ownerName = process.env.OWNER_DISPLAY_NAME || 'usuário'
  const TRIVIAL_PROMPT = `Você é o Orion, assistente pessoal do ${ownerName} no WhatsApp. Responda de forma curta, direta e conversacional, em português brasileiro. Não liste tarefas nem sessões a menos que perguntem.`

  const buildArgs = (withResume) => {
    const a = ['-p', augmentedMessage, '--output-format', 'json', '--dangerously-skip-permissions']
    if (withResume && resumeId) a.push('--resume', resumeId)
    else a.push('--system-prompt', trivial ? TRIVIAL_PROMPT : SYSTEM_PROMPT)
    return a
  }

  const workspaceDir = process.env.WORKSPACE_DIR ?? '/config/workspace'
  const callClaude = (withResume) => execa('claude', buildArgs(withResume), {
    timeout: trivial ? 45_000 : 150_000,
    cwd: workspaceDir,   // workspace principal → sessão visível no sidebar
    env: trivial ? { ...process.env, CLAUDE_CODE_DISABLE_MCP: '1' } : { ...process.env },
  })

  const isStaleResume = (err) => {
    const blob = `${err?.stderr ?? ''} ${err?.stdout ?? ''} ${err?.message ?? ''}`
    return /No conversation found|session ID|not found|--resume/i.test(blob)
  }
  const isTimeout = (err) => err?.timedOut === true || /timed out/i.test(err?.message ?? '')

  let output = ''
  let claudeSessionId = session.claude_session_id

  try {
    let result
    try {
      result = await callClaude(true)
    } catch (err) {
      if (resumeId && (isStaleResume(err) || isTimeout(err))) {
        const motivo = isTimeout(err) ? 'resume travou (timeout)' : 'resume inválido'
        log.warn({ resumeId, motivo, err: err.message }, '[orion] recomeçando sessão nova')
        try { updateClaudeSessionId(session.id, null) } catch {}
        if (registryEntry) { try { updateRegistrySessionId(registryEntry.id, null) } catch {} }
        result = await callClaude(false)
      } else {
        throw err
      }
    }

    const parsed = JSON.parse(result.stdout)
    output = parsed.result ?? parsed.content ?? ''
    claudeSessionId = parsed.session_id ?? claudeSessionId

    if (!trivial && claudeSessionId && claudeSessionId !== session.claude_session_id) {
      updateClaudeSessionId(session.id, claudeSessionId)
    }
    if (!trivial && registryEntry && claudeSessionId && claudeSessionId !== registryEntry.claude_session_id) {
      updateRegistrySessionId(registryEntry.id, claudeSessionId)
    }
  } catch (err) {
    log.error({ err: err.message, stderr: err?.stderr?.slice?.(0, 300) }, '[orion] Erro ao chamar claude')
    output = 'Tive um problema técnico. Tenta de novo em instantes.'
  }

  // Salvar resposta (sem o indicador de modo)
  saveMessage(session.id, 'assistant', output, channel)

  // Registrar custo estimado
  logCall({
    jid, sessionId: session.id,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    wasTrivial: trivial,
    inputChars: message.length,
    outputChars: output.length,
    channel,
    durationMs: Date.now() - _startMs,
  })

  // Gate de trivialidade — saudações NÃO disparam processamento background
  if (!isTrivialMessage(message)) {
    generateSkillIfWorthy(message, output).catch(() => {})
    updateUserProfile(message, output).catch(() => {})
    processExchange({
      userMessage: message,
      assistantResponse: output,
      source: channel,
      sessionId: session.id,
    })
  } else {
    log.debug({ msg: message.slice(0, 30) }, '[orion] mensagem trivial — sem processamento background')
  }

  // Prefixa o indicador de modo apenas no canal WhatsApp
  if (channel === 'whatsapp' && output) {
    const indicator = getModeIndicator(claudeSessionId)
    return `${indicator}\n${output}`
  }

  return output
}
