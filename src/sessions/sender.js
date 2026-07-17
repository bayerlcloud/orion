import { execa } from 'execa'
import { SESSION_CWD } from './reader.js'
import { randomUUID } from 'crypto'

const activeSends = new Map()

export function isSending(sessionId) {
  return activeSends.get(sessionId) === true
}

export async function sendToSession(sessionId, message, model = null) {
  if (activeSends.get(sessionId)) throw new Error('Sessão ocupada')
  activeSends.set(sessionId, true)
  try {
    const result = await execa('claude', [
      '--resume', sessionId, '-p', message,
      '--output-format', 'json', '--dangerously-skip-permissions',
      ...(model ? ['--model', model] : []),
    ], { cwd: SESSION_CWD, timeout: 300_000 })
    const parsed = JSON.parse(result.stdout)
    return parsed.result ?? parsed.content ?? ''
  } finally {
    activeSends.delete(sessionId)
  }
}

export function createNewSession(message, model = null) {
  const newId = randomUUID()
  execa('claude', [
    '--session-id', newId, '-p', message,
    '--output-format', 'json', '--dangerously-skip-permissions',
    ...(model ? ['--model', model] : []),
  ], { cwd: SESSION_CWD, timeout: 300_000 }).catch(err => console.error('[sessions] createNew:', err.message))
  return newId
}
