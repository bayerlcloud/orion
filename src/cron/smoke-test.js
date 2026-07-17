/**
 * Smoke test diário — exercita o caminho crítico de ponta a ponta.
 * Falha em qualquer item → alerta no WhatsApp.
 * Resultado em data/smoke-last.json e no endpoint /api/orion/smoke.
 */
import { execa } from 'execa'
import { writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'

const logger = createLogger('smoke')
const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULT_PATH = join(__dirname, '../../data/smoke-last.json')

async function check(name, fn, timeoutMs = 60_000) {
  const start = Date.now()
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ])
    return { name, ok: true, ms: Date.now() - start }
  } catch (err) {
    return { name, ok: false, ms: Date.now() - start, error: String(err.message).slice(0, 200) }
  }
}

export async function runSmokeTest() {
  logger.info('smoke test iniciado')
  const checks = []

  checks.push(await check('delegate-cli', async () => {
    const r = await execa('claude', [
      '-p', 'Responda apenas: ok',
      '--append-system-prompt', 'Você é um teste de sanidade. Responda literalmente o que for pedido.',
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
    ], { timeout: 90_000 })
    const parsed = JSON.parse(r.stdout)
    const out = String(parsed.result ?? parsed.content ?? '')
    if (!/ok/i.test(out)) throw new Error(`resposta inesperada: ${out.slice(0, 80)}`)
  }, 95_000))

  checks.push(await check('memoria-save-retrieve', async () => {
    const { saveMemory, retrieveMemories } = await import('../memory/index.js')
    const marker = `smoke-test-${Date.now()}`
    const id = saveMemory({ content: `Marcador de smoke test: ${marker}`, type: 'raw', source: 'smoke', confidence: 0.8, tags: ['smoke'], sourceTool: 'smoke-test' })
    if (!id) throw new Error('saveMemory não retornou id')
    const found = retrieveMemories(`Marcador de smoke test ${marker}`, { limit: 5 })
    getDb().prepare(`UPDATE memories SET archived = 1 WHERE id = ?`).run(id)
    if (!found.some(m => m.content?.includes(marker))) throw new Error('memória salva não foi encontrada no retrieval')
  }, 30_000))

  checks.push(await check('evolution-api', async () => {
    const url = `${process.env.EVOLUTION_API_URL}/instance/connectionState/${process.env.EVOLUTION_INSTANCE}`
    const r = await fetch(url, { headers: { apikey: process.env.EVOLUTION_API_KEY } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    const state = d?.instance?.state ?? d?.state
    if (state !== 'open') throw new Error(`instância não conectada: ${state}`)
  }, 15_000))

  checks.push(await check('playwright-mcp', async () => {
    const { request } = await import('node:http')
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })
    const text = await new Promise((resolve, reject) => {
      const req = request({
        host: 'playwright-mcp', port: 8931, path: '/mcp', method: 'POST',
        headers: { 'Host': 'localhost:8931', 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => resolve(buf))
      })
      req.on('error', reject)
      req.end(body)
    })
    if (!text.includes('"result"')) throw new Error(`handshake falhou: ${text.slice(0, 100)}`)
  }, 15_000))

  checks.push(await check('sqlite', async () => {
    const db = getDb()
    const n = db.prepare('SELECT COUNT(*) n FROM memories').get().n
    if (typeof n !== 'number') throw new Error('query falhou')
  }, 5_000))

  const failed = checks.filter(c => !c.ok)
  const result = { at: Math.floor(Date.now() / 1000), ok: failed.length === 0, checks }
  try { writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2)) } catch {}
  logger.info({ ok: result.ok, failed: failed.map(f => f.name) }, 'smoke test concluído')

  if (failed.length) {
    try {
      const { sendWhatsApp } = await import('../gateway/evolution.js')
      const jid = process.env.WHATSAPP_OWNER_JID
      const lines = failed.map(f => `• *${f.name}*: ${f.error}`).join('\n')
      if (jid) await sendWhatsApp(jid, `🔥 *Smoke test do Orion — ${failed.length} falha(s):*\n\n${lines}`)
    } catch (err) {
      logger.error({ err }, 'não consegui alertar no WhatsApp')
    }
  }
  return result
}

export function getLastSmokeResult() {
  try { return JSON.parse(readFileSync(RESULT_PATH, 'utf8')) } catch { return null }
}
