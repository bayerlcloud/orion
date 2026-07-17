/**
 * Orion SSE broadcast — singleton para eventos em tempo real.
 * Usado pelo chat web unificado (bidirec. com WhatsApp) e toasts de memória.
 */

const _clients = new Set()

export function addOrionClient(res) {
  _clients.add(res)
}

export function removeOrionClient(res) {
  _clients.delete(res)
}

export function getOrionClientCount() {
  return _clients.size
}

// ── Modo silencioso (noturno) ─────────────────────────────────────────────────
// Quando ativo, envios PROATIVOS pro WhatsApp são enfileirados (replies diretas
// a mensagens recebidas continuam passando — ver sendWhatsApp em evolution.js).
let _silent = false

export function setSilentMode(v) { _silent = Boolean(v) }
export function isSilentMode() { return _silent }

export function emitOrionEvent(type, data) {
  if (_clients.size === 0) return
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of _clients) {
    try {
      c.write(payload)
    } catch {
      _clients.delete(c)
    }
  }
}
