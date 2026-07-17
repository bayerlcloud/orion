const CREDS_PATH = process.env.CLAUDE_CREDENTIALS_PATH || '/root/.claude/.credentials.json'

import { readFileSync } from 'fs'

function readToken() {
  try {
    const d = JSON.parse(readFileSync(CREDS_PATH, 'utf8'))
    return d?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

let cache = null
let cacheAt = 0
const CACHE_TTL = 60_000

export async function fetchClaudeUsage() {
  if (cache && Date.now() - cacheAt < CACHE_TTL) return cache

  const token = readToken()
  if (!token) return null

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
        'Accept': 'application/json',
      },
    })
    if (!res.ok) return null
    const data = await res.json()

    const norm = (w) => w ? {
      pct: Math.round(w.utilization ?? 0),
      resets_at: w.resets_at ?? null,
    } : null

    cache = {
      session: norm(data.five_hour),
      week:    norm(data.seven_day),
      opus:    norm(data.seven_day_opus),
      sonnet:  norm(data.seven_day_sonnet),
      raw: data,
    }
    cacheAt = Date.now()
    return cache
  } catch {
    return null
  }
}
