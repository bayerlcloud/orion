/**
 * Working Memory — memória efêmera de alta prioridade, session-scoped.
 *
 * Captura fatos extraídos na SESSÃO ATUAL antes de consolidar para SQLite.
 * Analogia: RAM vs disco — acesso instantâneo, sem I/O, descartável.
 */

const MAX_PER_SESSION = 20
const TTL_SECS = 4 * 3600

const store = new Map()

export function addToWorkingMemory(sessionId, content, { category = 'general', source = 'wm' } = {}) {
  if (!sessionId || !content || String(content).length < 8) return
  if (!store.has(sessionId)) store.set(sessionId, [])
  const items = store.get(sessionId)
  if (items.some(i => i.content === content)) return
  items.push({ content: String(content), category, source, addedAt: Date.now() })
  if (items.length > MAX_PER_SESSION) items.splice(0, items.length - MAX_PER_SESSION)
}

export function getWorkingMemory(sessionId, query = '') {
  if (!sessionId) return []
  const items = store.get(sessionId) ?? []
  const now = Date.now()
  const validItems = items.filter(i => (now - i.addedAt) / 1000 < TTL_SECS)
  store.set(sessionId, validItems)
  if (!query) return validItems
  const qToks = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 3))
  if (qToks.size === 0) return validItems
  return validItems.filter(i => {
    const iToks = new Set(i.content.toLowerCase().split(/\W+/).filter(t => t.length > 3))
    let match = 0
    for (const t of qToks) if (iToks.has(t)) match++
    return match >= 1
  })
}

export function clearWorkingMemory(sessionId) {
  store.delete(sessionId)
}

export function formatWorkingMemoryContext(items) {
  if (!items || items.length === 0) return ''
  const lines = items.map(i => `- [${i.category}] ${i.content}`).join('\n')
  return `<working_memory>\n${lines}\n</working_memory>`
}
