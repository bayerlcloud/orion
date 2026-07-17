/**
 * Working Memory — memória efêmera de alta prioridade, session-scoped.
 *
 * Captura fatos extraídos na SESSÃO ATUAL antes de consolidar para SQLite.
 * Ao contrário da memória de longo prazo, nunca persiste além da sessão.
 * Peso máximo no retrieval — garante que "o que acabamos de discutir"
 * sempre surfaça antes de memórias antigas que possam contradizer.
 *
 * Analogia: RAM vs disco — acesso instantâneo, sem I/O, descartável.
 */

const MAX_PER_SESSION = 20  // máximo de items por sessão
const TTL_SECS = 4 * 3600   // itens somem após 4h sem uso (fallback de segurança)

// Store global: Map<sessionId, WorkingMemoryItem[]>
const store = new Map()

/**
 * Adiciona um fato à working memory da sessão.
 * Se a sessão não existe, cria.
 */
export function addToWorkingMemory(sessionId, content, { category = 'general', source = 'wm' } = {}) {
  if (!sessionId || !content || String(content).length < 8) return

  if (!store.has(sessionId)) store.set(sessionId, [])
  const items = store.get(sessionId)

  // Evitar duplicatas óbvias (conteúdo idêntico)
  if (items.some(i => i.content === content)) return

  items.push({ content: String(content), category, source, addedAt: Date.now() })

  // Limita tamanho (remove o mais antigo)
  if (items.length > MAX_PER_SESSION) items.splice(0, items.length - MAX_PER_SESSION)
}

/**
 * Retorna todos os items de working memory para a sessão,
 * filtrados por TTL e opcionalmente por relevância de query.
 */
export function getWorkingMemory(sessionId, query = '') {
  if (!sessionId) return []
  const items = store.get(sessionId) ?? []
  const now = Date.now()
  const validItems = items.filter(i => (now - i.addedAt) / 1000 < TTL_SECS)

  // Atualiza store removendo expirados
  store.set(sessionId, validItems)

  if (!query) return validItems

  // Se query fornecida, filtra por relevância rápida (word overlap)
  const qToks = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 3))
  if (qToks.size === 0) return validItems

  return validItems.filter(i => {
    const iToks = new Set(i.content.toLowerCase().split(/\W+/).filter(t => t.length > 3))
    let match = 0
    for (const t of qToks) if (iToks.has(t)) match++
    return match >= 1  // pelo menos 1 token em comum
  })
}

/**
 * Limpa a working memory de uma sessão.
 * Chamado ao comprimir ou fechar sessão.
 */
export function clearWorkingMemory(sessionId) {
  store.delete(sessionId)
}

/**
 * Formata working memory como string para injeção no contexto do agente.
 */
export function formatWorkingMemoryContext(items) {
  if (!items || items.length === 0) return ''
  const lines = items.map(i => `- [${i.category}] ${i.content}`).join('\n')
  return `<working_memory>\n${lines}\n</working_memory>`
}
