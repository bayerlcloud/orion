/**
 * Turn Context Hooks — metadados por turno para comportamento adaptativo.
 *
 * Inspirado no turn_context.py do Hermes.
 * Providers podem registrar hooks para reagir a eventos de turno:
 *   - onTurnStart: novo turno começando
 *   - onTurnEnd: turno respondido
 *   - onSessionSwitch: sessão trocou
 *   - onPreCompress: compressão vai acontecer
 *
 * Usado por:
 *   - drift-detector: aumenta vigilância quando tokens < 20%
 *   - tiered-summarizer: usa tier1 quando contexto grande
 *   - temporal-index: indexa eventos do turno
 */

import { createLogger } from '../logger.js'
const log = createLogger('turn-ctx')

const _turnStartHandlers  = []
const _turnEndHandlers    = []
const _sessionHandlers    = []
const _preCompressHandlers = []

/** Registra um handler para início de turno. */
export function onTurnStart(fn) { _turnStartHandlers.push(fn) }

/** Registra um handler para fim de turno. */
export function onTurnEnd(fn) { _turnEndHandlers.push(fn) }

/** Registra um handler para troca de sessão. */
export function onSessionSwitch(fn) { _sessionHandlers.push(fn) }

/** Registra um handler para pré-compressão. */
export function onPreCompress(fn) { _preCompressHandlers.push(fn) }

/**
 * Emite início de turno para todos os handlers.
 * @param {object} ctx
 * @param {number} ctx.turnNumber
 * @param {string} ctx.message
 * @param {number} [ctx.remainingTokens]
 * @param {string} [ctx.model]
 * @param {string} [ctx.platform] - 'whatsapp'|'chat_ui'|'cron'|'plugin'
 * @param {string} [ctx.sessionId]
 */
export function emitTurnStart(ctx) {
  for (const fn of _turnStartHandlers) {
    try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onTurnStart error') }
  }
}

export function emitTurnEnd(ctx) {
  for (const fn of _turnEndHandlers) {
    try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onTurnEnd error') }
  }
}

export function emitSessionSwitch(ctx) {
  for (const fn of _sessionHandlers) {
    try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onSessionSwitch error') }
  }
}

export function emitPreCompress(ctx) {
  for (const fn of _preCompressHandlers) {
    try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onPreCompress error') }
  }
}

// ── Handler padrão: comportamento adaptativo baseado em metadados do turno ───

/** Contexto de turno atual — compartilhado por todos os módulos. */
let _currentCtx = null

export function getCurrentTurnCtx() { return _currentCtx }

onTurnStart(ctx => {
  _currentCtx = { ...ctx, startedAt: Date.now() }

  // Threshold de tokens: se < 20% restante → comprimir mais agressivamente
  if (ctx.remainingTokens != null && ctx.remainingTokens < 0.20) {
    _currentCtx.aggressiveCompression = true
    log.debug({ remaining: ctx.remainingTokens }, '[turn-ctx] modo compressão agressiva')
  }
})

onTurnEnd(ctx => {
  if (_currentCtx) {
    _currentCtx.duration = Date.now() - (_currentCtx.startedAt ?? Date.now())
  }
})
