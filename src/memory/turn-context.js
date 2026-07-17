/**
 * Turn Context Hooks — metadados por turno para comportamento adaptativo.
 */

import { createLogger } from '../logger.js'
const log = createLogger('turn-ctx')

const _turnStartHandlers   = []
const _turnEndHandlers     = []
const _sessionHandlers     = []
const _preCompressHandlers = []

export function onTurnStart(fn)    { _turnStartHandlers.push(fn) }
export function onTurnEnd(fn)      { _turnEndHandlers.push(fn) }
export function onSessionSwitch(fn){ _sessionHandlers.push(fn) }
export function onPreCompress(fn)  { _preCompressHandlers.push(fn) }

export function emitTurnStart(ctx) {
  for (const fn of _turnStartHandlers) { try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onTurnStart error') } }
}
export function emitTurnEnd(ctx) {
  for (const fn of _turnEndHandlers) { try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onTurnEnd error') } }
}
export function emitSessionSwitch(ctx) {
  for (const fn of _sessionHandlers) { try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onSessionSwitch error') } }
}
export function emitPreCompress(ctx) {
  for (const fn of _preCompressHandlers) { try { fn(ctx) } catch (err) { log.debug({ err: err.message }, '[turn-ctx] onPreCompress error') } }
}

let _currentCtx = null
export function getCurrentTurnCtx() { return _currentCtx }

onTurnStart(ctx => {
  _currentCtx = { ...ctx, startedAt: Date.now() }
  if (ctx.remainingTokens != null && ctx.remainingTokens < 0.20) {
    _currentCtx.aggressiveCompression = true
    log.debug({ remaining: ctx.remainingTokens }, '[turn-ctx] modo compressão agressiva')
  }
})

onTurnEnd(ctx => {
  if (_currentCtx) _currentCtx.duration = Date.now() - (_currentCtx.startedAt ?? Date.now())
})
