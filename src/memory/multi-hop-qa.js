/**
 * Multi-hop QA — responde perguntas composicionais via chain de raciocínio.
 *
 * Decompõe a query em sub-passos via Haiku, executa cada step com
 * os retrievers existentes (keyword, entity, temporal, causal), sintetiza.
 */

import { execa } from 'execa'
import { retrieveMemories } from './index.js'
import { getMemoriesInPeriod } from './temporal-index.js'
import { getEffects, getCauses } from './causal-graph.js'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
const log = createLogger('multihop')

async function decomposeQuery(question) {
  const prompt = `Decomponha esta pergunta em passos de raciocínio para busca em memória.
Retorne JSON: {"steps": [{"step": "descrição", "type": "entity|temporal|keyword|causal", "query": "texto de busca"}]}
Máximo 4 passos. Se simples, retorne 1 passo.

Pergunta: "${question}"`
  try {
    const r = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'], { timeout: 15_000 })
    const raw = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    return JSON.parse(raw).steps ?? [{ step: 'busca direta', type: 'keyword', query: question }]
  } catch {
    return [{ step: 'busca direta', type: 'keyword', query: question }]
  }
}

function executeStep(step, context = {}) {
  const { type, query } = step
  const db = getDb()
  if (type === 'entity') {
    try { return db.prepare(`SELECT name, type, description FROM entities WHERE name LIKE ? LIMIT 5`).all(`%${query}%`).map(e => ({ content: `${e.name} (${e.type}): ${e.description ?? 'sem descrição'}` })) } catch { return [] }
  } else if (type === 'temporal') {
    const epoch = context.lastEpoch ?? (Math.floor(Date.now() / 1000) - 30 * 86400)
    return getMemoriesInPeriod(epoch, Math.floor(Date.now() / 1000), 10)
      .filter(r => r.content.toLowerCase().includes(query.toLowerCase().split(' ')[0]))
  } else if (type === 'causal') {
    const effects = getEffects(query, 5)
    const causes = getCauses(query, 5)
    return [
      ...effects.map(e => ({ content: `Efeito de "${query}": ${e.effect} (conf: ${e.confidence})` })),
      ...causes.map(c => ({ content: `Causa de "${query}": ${c.cause} (conf: ${c.confidence})` })),
    ]
  } else {
    return retrieveMemories(query, { limit: 5 })
  }
}

async function synthesize(question, steps, results) {
  const evidence = results.flat().filter(Boolean).slice(0, 15).map((r, i) => `[${i + 1}] ${r.content}`).join('\n')
  if (!evidence) return { answer: 'Não encontrei evidências suficientes na memória para responder.', confidence: 0 }
  const prompt = `Responda à pergunta usando APENAS as evidências fornecidas. Seja direto.
Se não há evidências suficientes, diga explicitamente.

Pergunta: "${question}"

Evidências:
${evidence}

Resposta:`
  try {
    const r = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json', '--dangerously-skip-permissions'], { timeout: 20_000 })
    const answer = (JSON.parse(r.stdout).result ?? JSON.parse(r.stdout).content ?? '').trim()
    return { answer, confidence: evidence.length > 0 ? 0.7 : 0.2, evidenceCount: results.flat().length }
  } catch { return { answer: 'Erro ao sintetizar resposta.', confidence: 0 } }
}

export async function multiHopQuery(question) {
  log.debug({ question: question.slice(0, 80) }, '[multihop] iniciando')
  const steps = await decomposeQuery(question)
  const trace = []
  const allResults = []
  let context = {}
  for (const step of steps) {
    const results = executeStep(step, context)
    allResults.push(results)
    trace.push({ ...step, resultCount: results.length })
    for (const r of results) { if (r?.created_at) context.lastEpoch = Math.max(context.lastEpoch ?? 0, r.created_at) }
  }
  const synthesis = await synthesize(question, steps, allResults)
  return { ...synthesis, steps, trace }
}
