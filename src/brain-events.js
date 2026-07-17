import { EventEmitter } from 'events'

const bus = new EventEmitter()
bus.setMaxListeners(50)

const RING_SIZE = 200
const ring = []

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

export function onBrainEvent(fn) {
  bus.on('event', fn)
  return () => bus.off('event', fn)
}

export function getRecentEvents(limit = 80) {
  return ring.slice(-limit)
}
