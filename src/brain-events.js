/**
 * Brain Events — barramento de eventos central do "cérebro" do Orion.
 *
 * Pontos do motor (memory write, fases, crons, skills) emitem eventos aqui.
 * A página /brain consome via SSE para mostrar a atividade ao vivo.
 *
 * Mantém um ring buffer dos últimos N eventos para que a UI carregue
 * o histórico recente ao conectar.
 */

import { EventEmitter } from 'events'

const bus = new EventEmitter()
bus.setMaxListeners(50)

const RING_SIZE = 200
const ring = []

/**
 * Emite um evento de atividade do cérebro.
 * @param {string} type - memory | skill | causal | contradiction | cron | phase | drift | dedup | alert | info
 * @param {object} data - payload livre (text, category, confidence, id, etc.)
 */
export function emitBrain(type, data = {}) {
  const evt = {
    type,
    ts: Math.floor(Date.now() / 1000),
    ...data,
  }
  ring.push(evt)
  if (ring.length > RING_SIZE) ring.shift()
  try { bus.emit('event', evt) } catch {}
  return evt
}

/** Inscreve um listener; retorna função de cancelamento. */
export function onBrainEvent(fn) {
  bus.on('event', fn)
  return () => bus.off('event', fn)
}

/** Retorna os últimos eventos do ring buffer (para hidratar a UI ao conectar). */
export function getRecentEvents(limit = 80) {
  return ring.slice(-limit)
}
