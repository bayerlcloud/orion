import { readdirSync, statSync, readFileSync, writeFileSync, watch, existsSync, openSync, readSync, fstatSync, closeSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { getDb } from '../db/index.js'
import { SESSIONS_DIR, SESSION_CWD, parseSession, readNewLines, parseLine, parseLineItems } from './reader.js'

// VS Code extension global-state file (override via env for portability)
const VS_GLOBAL_STATE = process.env.VSCODE_GLOBAL_STATE_PATH ?? '/config/data/User/globalStorage/storage.json'

// SSE clients: sessionId → Set<res>
const sseClients = new Map()

// File position tracking for incremental reads
const filePositions = new Map()

// Active file watchers
const fileWatchers = new Map()

export function addSseClient(sessionId, res) {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set())
  sseClients.get(sessionId).add(res)
}

export function removeSseClient(sessionId, res) {
  sseClients.get(sessionId)?.delete(res)
}

function broadcast(sessionId, data) {
  const clients = sseClients.get(sessionId)
  if (!clients?.size) return
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const res of clients) { try { res.write(payload) } catch {} }
}

let _activeCache = { ts: 0, val: new Set(), pidMap: new Map() }

export function getLastRoleLive(filepath) { return _lastEntryType(filepath) }
function _lastEntryType(filepath) {
  try {
    const fd = openSync(filepath, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - 60000)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue
        let o; try { o = JSON.parse(lines[i]) } catch { continue }
        if (o.type === 'user' || o.type === 'assistant') return o.type
      }
    } finally { closeSync(fd) }
  } catch {}
  return null
}

function hasChildProcesses(pid) {
  if (!pid) return false
  try {
    const out = execSync(`pgrep -P ${pid} 2>/dev/null | xargs -r -I{} ps -p {} -o comm= 2>/dev/null | grep -c bash || true`, { encoding: 'utf8', timeout: 800 })
    return parseInt(out.trim()) > 0
  } catch { return false }
}

export function getActiveSessions() {
  const now = Date.now()
  if (now - _activeCache.ts < 800) return _activeCache.val
  try {
    const out = execSync('pgrep -af -- --resume 2>/dev/null || true', { encoding: 'utf8', timeout: 2000 })
    const active = new Set()
    const pidMap = new Map()
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+).*claude.*--resume\s+([a-f0-9-]{36})/)
      if (m) { active.add(m[2]); pidMap.set(m[2], parseInt(m[1])) }
    }
    _activeCache = { ts: now, val: active, pidMap }
    return active
  } catch { return _activeCache.val }
}

export function getSessionPid(id) { return _activeCache.pidMap.get(id) ?? null }

// Sessões criadas por turnos de conversa do agente não devem poluir o browser de Sessões.
export function isConversationSession(msg) {
  if (!msg) return false
  if (/<resumo_sessao>|<sessoes_claude_code>|<memoria_proativa>|\[Skill ativada:/i.test(msg)) return true
  if (/^\s*(fal+a?\s+orion|ol[áa]\s*,?\s*orion|oi+\b|e\s*a[íí]\b|opa\b|bom dia|boa tarde|boa noite|tudo bem|responda só)/i.test(msg)) return true
  return false
}

const FACT_SIGNALS = /\b(compr|adquir|contrat|decidi|decidimos|prefir|prefiro|gosto|odeio|uso |usamos|utilizo|meu |minha |meus |minhas |novo projeto|criei|lembr[ae]|na verdade|mudei|troc[ao]|vamos usar|passei a|senha|credencial|chave|token|ip |dom[ií]nio|e-?mail|telefone|cpf|chama-?se|chamad[ao]|se chama)\b/i

async function capturePluginFact(text, sessionId) {
  try {
    const t = (text ?? '').trim()
    if (t.length < 25) return
    if (t.startsWith('/') || t.startsWith('Continue from where')) return
    if (isConversationSession(t)) return
    if (!FACT_SIGNALS.test(t)) return
    const { processExchange } = await import('../memory/index.js')
    processExchange({ userMessage: t, assistantResponse: t, source: 'plugin', sessionId })
  } catch {}
}

async function indexFile(filepath) {
  const id = filepath.split('/').pop().replace('.jsonl', '')
  const db = getDb()
  let stat
  try { stat = statSync(filepath) } catch { return }
  const { messages, customTitle, aiTitle, firstUserMsg } = await parseSession(filepath)
  const msgCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length
  db.prepare(`
    INSERT INTO claude_sessions (id, path, cwd, custom_title, ai_title, last_modified, message_count, first_user_msg, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      custom_title  = excluded.custom_title,
      ai_title      = excluded.ai_title,
      last_modified = excluded.last_modified,
      message_count = excluded.message_count,
      first_user_msg = excluded.first_user_msg,
      deleted_at    = NULL,
      indexed_at    = unixepoch()
  `).run(id, filepath, SESSION_CWD, customTitle ?? null, aiTitle ?? null,
         Math.floor(stat.mtimeMs / 1000), msgCount, firstUserMsg ?? null)
  if (!customTitle && isConversationSession(firstUserMsg)) {
    try { db.prepare('UPDATE claude_sessions SET hidden = 1 WHERE id = ?').run(id) } catch {}
  }
  filePositions.set(filepath, stat.size)
}

function markDeleted(id) {
  getDb().prepare('UPDATE claude_sessions SET deleted_at = unixepoch() WHERE id = ? AND deleted_at IS NULL').run(id)
  broadcast('__list__', { type: 'session_deleted', sessionId: id })
}

const processingFiles = new Set()

async function processNewLines(filepath, id) {
  if (processingFiles.has(filepath)) return
  const fromByte = filePositions.get(filepath)
  if (fromByte == null) return
  processingFiles.add(filepath)
  try {
    let res
    try { res = await readNewLines(filepath, fromByte) } catch { return }
    const { lines, newPos } = res
    if (!lines.length) return
    filePositions.set(filepath, newPos)
    let lastRole = null
    for (const raw of lines) {
      for (const item of parseLineItems(raw)) {
        broadcast(id, { type: 'tl', item })
        if (item.kind === 'user' && item.text) capturePluginFact(item.text, id)
        if (item.kind === 'user') lastRole = 'user'
        if (item.kind === 'say')  lastRole = 'assistant'
      }
      const cm = raw.match(/"customTitle":"([^"]+)"/)
      if (cm) {
        getDb().prepare('UPDATE claude_sessions SET custom_title = ? WHERE id = ?').run(cm[1], id)
        broadcast(id, { type: 'title', title: cm[1] })
      }
    }
    try {
      const stat = statSync(filepath)
      const db = getDb()
      const msgDelta = lines.filter(l => l.includes('"type":"user"') || l.includes('"type":"assistant"')).length
      if (lastRole) {
        db.prepare('UPDATE claude_sessions SET last_modified = ?, message_count = message_count + ?, last_msg_role = ? WHERE id = ?')
          .run(Math.floor(stat.mtimeMs / 1000), msgDelta, lastRole, id)
        broadcast(id, { type: 'role', role: lastRole })
        if (lastRole === 'user') {
          db.prepare('UPDATE claude_sessions SET needs_attention = 0 WHERE id = ?').run(id)
        }
      } else {
        db.prepare('UPDATE claude_sessions SET last_modified = ?, message_count = message_count + ? WHERE id = ?')
          .run(Math.floor(stat.mtimeMs / 1000), msgDelta, id)
      }
    } catch {}
  } finally { processingFiles.delete(filepath) }
}

function watchFile(filepath) {
  if (fileWatchers.has(filepath)) return
  const id = filepath.split('/').pop().replace('.jsonl', '')
  const watcher = watch(filepath, (event) => { if (event === 'change') processNewLines(filepath, id) })
  fileWatchers.set(filepath, watcher)
}

function watchDirectory() {
  try {
    watch(SESSIONS_DIR, async (event, filename) => {
      if (!filename?.endsWith('.jsonl')) return
      const filepath = join(SESSIONS_DIR, filename)
      const id = filename.replace('.jsonl', '')
      if (existsSync(filepath)) {
        await indexFile(filepath); watchFile(filepath)
        broadcast('__list__', { type: 'new_session', sessionId: id })
      } else {
        markDeleted(id)
        const w = fileWatchers.get(filepath)
        if (w) { try { w.close() } catch {} fileWatchers.delete(filepath) }
      }
    })
  } catch {}
}

function applyVsCodeHiddenIds() {
  try {
    const raw = JSON.parse(readFileSync(VS_GLOBAL_STATE, 'utf8'))
    const ext = raw['anthropic.claude-code']
    if (!ext) return
    const state = typeof ext === 'string' ? JSON.parse(ext) : ext
    const ids = state?.hiddenSessionIds ?? []
    if (!ids.length) return
    const db = getDb()
    const stmt = db.prepare('UPDATE claude_sessions SET hidden = 1 WHERE id = ? AND hidden = 0')
    let count = 0
    for (const id of ids) { const r = stmt.run(id); count += r.changes }
    if (count > 0) console.log(`[sessions] ${count} sessões ocultas via VS Code hiddenSessionIds`)
  } catch {}
}

function watchVsCodeGlobalState() {
  const dir = VS_GLOBAL_STATE.replace('/storage.json', '')
  try {
    watch(dir, (event, filename) => { if (filename === 'storage.json') setTimeout(applyVsCodeHiddenIds, 300) })
    applyVsCodeHiddenIds()
  } catch {}
}

function startActiveMonitor() {
  let _prev = new Set()
  const _pendingExit = new Map()
  setInterval(() => {
    try {
      _activeCache.ts = 0
      const current = getActiveSessions()
      const now = Date.now()
      const entered = [...current].filter(id => !_prev.has(id))
      if (entered.length) {
        const db = getDb()
        const clearStmt = db.prepare('UPDATE claude_sessions SET needs_attention = 0 WHERE id = ? AND hidden = 0 AND deleted_at IS NULL')
        entered.forEach(id => { _pendingExit.delete(id); clearStmt.run(id) })
      }
      const exited = [..._prev].filter(id => !current.has(id))
      exited.forEach(id => { if (!_pendingExit.has(id)) _pendingExit.set(id, now) })
      const readyToMark = [..._pendingExit].filter(([id, ts]) => now - ts >= 6000 && !current.has(id))
      if (readyToMark.length) {
        const db = getDb()
        const stmt = db.prepare("UPDATE claude_sessions SET needs_attention = 1 WHERE id = ? AND last_msg_role = 'assistant' AND hidden = 0 AND deleted_at IS NULL")
        readyToMark.forEach(([id]) => { stmt.run(id); _pendingExit.delete(id) })
      }
      const changed = current.size !== _prev.size || [...current].some(id => !_prev.has(id)) || [..._prev].some(id => !current.has(id))
      if (changed) { broadcast('__list__', { type: 'status_changed', active: [...current], finished: [] }); _prev = new Set(current) }
    } catch {}
  }, 2000)
}

function startPolling() {
  setInterval(async () => {
    try {
      const db = getDb()
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))
      const known = new Set(db.prepare('SELECT id FROM claude_sessions').all().map(r => r.id))
      for (const f of files) {
        const id = f.replace('.jsonl', '')
        const filepath = join(SESSIONS_DIR, f)
        if (!known.has(id)) {
          await indexFile(filepath); watchFile(filepath)
          broadcast('__list__', { type: 'new_session', sessionId: id })
          console.log(`[sessions] nova sessão detectada (poll): ${id.slice(0, 8)}`)
        } else {
          await processNewLines(filepath, id)
        }
      }
    } catch {}
  }, 5_000)
}

export async function initSessionIndex() {
  let files
  try { files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')) }
  catch { console.error('[sessions] diretório não encontrado:', SESSIONS_DIR); return }
  console.log(`[sessions] indexando ${files.length} sessões...`)
  const batchSize = 10
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    await Promise.all(batch.map(f => indexFile(join(SESSIONS_DIR, f))))
  }
  const db = getDb()
  const inDb = db.prepare('SELECT id, path FROM claude_sessions WHERE deleted_at IS NULL').all()
  const onDisk = new Set(files.map(f => f.replace('.jsonl', '')))
  for (const row of inDb) { if (!onDisk.has(row.id)) markDeleted(row.id) }
  for (const f of files) watchFile(join(SESSIONS_DIR, f))
  watchDirectory()
  watchVsCodeGlobalState()
  startPolling()
  startActiveMonitor()
  console.log(`[sessions] índice pronto`)
}

export function listSessions({ limit = 200, search = '', showDeleted = true, showHidden = false } = {}) {
  const db = getDb()
  const activePids = getActiveSessions()
  const hiddenFilter = showHidden ? '' : 'AND (hidden = 0 OR hidden IS NULL)'
  const deletedFilter = showDeleted ? '' : 'AND deleted_at IS NULL'
  const extraCols = `, u1.display_name AS actor_name, u1.avatar_color AS actor_color, u1.username AS actor_username, u2.display_name AS creator_name, u2.avatar_color AS creator_color`
  const extraJoins = `LEFT JOIN users u1 ON u1.id = cs.last_actor LEFT JOIN users u2 ON u2.id = cs.created_by`
  let rows
  if (search) {
    rows = db.prepare(`SELECT cs.*${extraCols} FROM claude_sessions cs ${extraJoins} WHERE (cs.custom_title LIKE ? OR cs.ai_title LIKE ? OR cs.first_user_msg LIKE ?) ${hiddenFilter.replace(/hidden/g, 'cs.hidden')} ${deletedFilter.replace('deleted_at', 'cs.deleted_at')} ORDER BY cs.last_modified DESC LIMIT ?`).all(`%${search}%`, `%${search}%`, `%${search}%`, limit)
  } else {
    rows = db.prepare(`SELECT cs.*${extraCols} FROM claude_sessions cs ${extraJoins} WHERE 1=1 ${hiddenFilter.replace(/hidden/g, 'cs.hidden')} ${deletedFilter.replace('deleted_at', 'cs.deleted_at')} ORDER BY cs.last_modified DESC LIMIT ?`).all(limit)
  }
  const TWO_HOURS = 7200
  const nowSec = Math.floor(Date.now() / 1000)
  return rows.map(s => {
    let currentRole = s.last_msg_role
    if (activePids.has(s.id)) {
      const filepath = join(SESSIONS_DIR, `${s.id}.jsonl`)
      const live = _lastEntryType(filepath)
      if (live) currentRole = live
      if (currentRole === 'assistant') {
        const pid = _activeCache.pidMap.get(s.id)
        if (hasChildProcesses(pid)) {
          currentRole = 'user'
        } else {
          try { if (Date.now() - statSync(filepath).mtimeMs < 10000) currentRole = 'user' } catch {}
        }
      }
    }
    if (activePids.has(s.id) && currentRole === 'user' && s.needs_attention) {
      setImmediate(() => { try { getDb().prepare('UPDATE claude_sessions SET needs_attention = 0 WHERE id = ?').run(s.id) } catch {} })
    }
    return {
      ...s,
      status: s.deleted_at ? 'deleted'
            : activePids.has(s.id) && currentRole !== 'assistant' ? 'active'
            : activePids.has(s.id) ? 'waiting'
            : s.needs_attention ? 'finished'
            : (s.last_modified && (nowSec - s.last_modified) < TWO_HOURS) ? 'waiting'
            : 'paused'
    }
  })
}

export function getSession(id) { return getDb().prepare('SELECT * FROM claude_sessions WHERE id = ?').get(id) }
export function renameSession(id, title) { getDb().prepare('UPDATE claude_sessions SET custom_title = ? WHERE id = ?').run(title, id) }
export function clearAttention(id) { getDb().prepare('UPDATE claude_sessions SET needs_attention = 0 WHERE id = ?').run(id) }
export function openSession(id) { getDb().prepare('UPDATE claude_sessions SET opened_at = unixepoch() WHERE id = ?').run(id) }
export function closeSessionPin(id) { getDb().prepare('UPDATE claude_sessions SET opened_at = NULL WHERE id = ?').run(id) }
export function hardDeleteSession(id) {
  getDb().prepare('UPDATE claude_sessions SET deleted_at = unixepoch(), hidden = 1 WHERE id = ?').run(id)
  broadcast('__list__', { type: 'session_deleted', sessionId: id })
}
export function hideSession(id) { getDb().prepare('UPDATE claude_sessions SET hidden = 1 WHERE id = ?').run(id); syncHiddenToVsCode() }
export function showSession(id) { getDb().prepare('UPDATE claude_sessions SET hidden = 0 WHERE id = ?').run(id); syncHiddenToVsCode() }

function syncHiddenToVsCode() {
  try {
    const db = getDb()
    const hidden = db.prepare('SELECT id FROM claude_sessions WHERE hidden = 1').all().map(r => r.id)
    let existing = {}
    if (existsSync(VS_GLOBAL_STATE)) {
      try { const raw = JSON.parse(readFileSync(VS_GLOBAL_STATE, 'utf8')); const ext = raw['anthropic.claude-code']; existing = typeof ext === 'string' ? JSON.parse(ext) : (ext ?? {}) } catch {}
    }
    const updated = { ...existing, hiddenSessionIds: hidden }
    writeFileSync(VS_GLOBAL_STATE, JSON.stringify({ 'anthropic.claude-code': JSON.stringify(updated) }, null, 2), 'utf8')
  } catch (e) { console.error('[sessions] sync vscode hidden:', e.message) }
}
