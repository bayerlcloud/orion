/**
 * Insights — custo estimado e métricas de uso do Orion.
 * Tokens estimados: 4 chars/token (baseline razoável).
 *
 * Preços USD aproximados por 1M tokens:
 *   claude-sonnet-4-6: input $3, output $15
 *   claude-haiku-4-5:  input $0.8, output $4
 */
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const logger = createLogger('insights')

const MODEL_PRICES = {
  'claude-sonnet-4-6':          { input: 3 / 1e6,   output: 15 / 1e6 },
  'claude-haiku-4-5':           { input: 0.8 / 1e6, output: 4 / 1e6  },
  'claude-haiku-4-5-20251001':  { input: 0.8 / 1e6, output: 4 / 1e6  },
  default:                       { input: 3 / 1e6,   output: 15 / 1e6 },
}

function estimateTokens(chars) { return Math.round((chars ?? 0) / 4) }

function estimateCost(model, inputChars, outputChars) {
  const prices = MODEL_PRICES[model] ?? MODEL_PRICES.default
  return estimateTokens(inputChars) * prices.input + estimateTokens(outputChars) * prices.output
}

export function logCall({ jid, sessionId, model, wasTrivial, inputChars, outputChars, channel, durationMs } = {}) {
  try {
    const db = getDb()
    const inTok  = estimateTokens(inputChars)
    const outTok = estimateTokens(outputChars)
    const cost   = estimateCost(model ?? 'default', inputChars ?? 0, outputChars ?? 0)
    db.prepare(`
      INSERT INTO call_log (jid, session_id, model, was_trivial, input_chars, output_chars,
        est_input_tokens, est_output_tokens, est_cost_usd, channel, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jid ?? null, sessionId ?? null, model ?? null, wasTrivial ? 1 : 0,
      inputChars ?? 0, outputChars ?? 0, inTok, outTok, cost,
      channel ?? null, durationMs ?? null
    )
  } catch (err) {
    logger.warn({ err }, 'logCall falhou (silencioso)')
  }
}

export function getInsights(days = 30) {
  const db = getDb()
  const since = Math.floor(Date.now() / 1000) - days * 86400

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(was_trivial) as trivial_calls,
      SUM(est_input_tokens) as total_input_tokens,
      SUM(est_output_tokens) as total_output_tokens,
      ROUND(SUM(est_cost_usd), 4) as total_cost_usd,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM call_log WHERE ts >= ?
  `).get(since)

  const byDay = db.prepare(`
    SELECT date(ts, 'unixepoch', 'localtime') as day,
      COUNT(*) as calls,
      ROUND(SUM(est_cost_usd), 4) as cost_usd
    FROM call_log WHERE ts >= ?
    GROUP BY day ORDER BY day DESC
  `).all(since)

  const byModel = db.prepare(`
    SELECT model,
      COUNT(*) as calls,
      ROUND(SUM(est_cost_usd), 4) as cost_usd
    FROM call_log WHERE ts >= ?
    GROUP BY model ORDER BY cost_usd DESC
  `).all(since)

  return { totals, byDay, byModel, periodDays: days }
}
