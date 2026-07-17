/**
 * Fase 7 — Cross-session Pattern Mining (Semanal, domingo 23h)
 */

import { getDb } from '../db/index.js'
import { execa } from 'execa'
import { sendWhatsApp } from '../gateway/evolution.js'
import { logger } from '../logger.js'
import { saveMemory } from '../memory/index.js'
import { writeFileSync } from 'node:fs'

const VAULT_MEMORY_PATH = process.env.VAULT_ROOT
  ? `${process.env.VAULT_ROOT}/Orion/memoria/`
  : '/config/workspace/notes/Orion/memoria/'

async function callHaiku(prompt) {
  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000 })
    const parsed = JSON.parse(result.stdout)
    return (parsed.result ?? parsed.content ?? '').trim()
  } catch { return null }
}

export async function runPhase7() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const weekAgo = now - 7 * 86400

  const topAccessed = db.prepare(`
    SELECT id, content, category, access_count, confidence
    FROM memories WHERE archived=0 AND last_accessed>?
    ORDER BY access_count DESC LIMIT 30
  `).all(weekAgo)

  const topCoRetrievals = db.prepare(`SELECT id_a, id_b, count FROM co_retrievals ORDER BY count DESC LIMIT 20`).all()

  const catStats = db.prepare(`
    SELECT category, COUNT(*) as cnt, AVG(confidence) as avg_conf
    FROM memories WHERE archived=0 GROUP BY category ORDER BY cnt DESC
  `).all()

  const orphans = db.prepare(`
    SELECT id, content, category, access_count, confidence
    FROM memories WHERE archived=0 AND access_count>=5 AND confidence<0.4
    ORDER BY access_count DESC LIMIT 10
  `).all()

  let promoted = 0
  for (const m of orphans) {
    const boostConf = Math.min(0.7, m.confidence + 0.15)
    db.prepare(`UPDATE memories SET confidence=?, updated_at=? WHERE id=?`).run(boostConf, now, m.id)
    promoted++
  }

  if (topAccessed.length > 0) {
    const contentSample = topAccessed.slice(0, 10).map(m => `- [${m.category}] ${m.content.slice(0, 80)}`).join('\n')
    const analysisPrompt = `Analise estes fatos mais acessados da memória de um agente pessoal na última semana:\n${contentSample}\n\nIdentificar:\n1. Padrão temático principal (1 frase)\n2. Domínio de conhecimento mais ativo\n3. Possível gap: qual categoria de fato DEVERIA existir mas provavelmente não existe?\n4. Sugestão: 1 fato sintético que resumiria os padrões observados\n\nRetorne JSON: {"theme": "...", "domain": "...", "gap": "...", "synthesis_fact": "..."}`
    const raw = await callHaiku(analysisPrompt)
    if (raw) {
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const analysis = JSON.parse(jsonMatch[0])
          if (analysis.synthesis_fact && String(analysis.synthesis_fact).length > 20) {
            await saveMemory({ content: `[pattern-mining] ${analysis.synthesis_fact}`, type: 'semantic', source: 'cron', category: 'general', confidence: 0.6, sourceTool: 'phase7-mining' })
          }
          const vaultNote = `# Pattern Mining — ${new Date().toISOString().slice(0, 10)}\n\n## Tema principal\n${analysis.theme ?? 'N/A'}\n\n## Domínio mais ativo\n${analysis.domain ?? 'N/A'}\n\n## Gap identificado\n${analysis.gap ?? 'N/A'}\n\n## Fato sintético gerado\n${analysis.synthesis_fact ?? 'N/A'}\n\n## Estatísticas\n- Memórias analisadas: ${topAccessed.length}\n- Co-retrievals rastreados: ${topCoRetrievals.length}\n- Memórias promovidas (conf↑): ${promoted}\n- Distribuição: ${catStats.map(c => `${c.category}=${c.cnt}`).join(', ')}\n`
          try { writeFileSync(`${VAULT_MEMORY_PATH}pattern-mining-${new Date().toISOString().slice(0, 10)}.md`, vaultNote, 'utf8') } catch {}
        }
      } catch {}
    }
  }

  const summary = `🔬 *Pattern Mining semanal*\n📊 ${topAccessed.length} memórias analisadas\n🔗 ${topCoRetrievals.length} co-retrievals\n🌱 ${promoted} memórias promovidas\n📁 ${catStats.length} categorias`
  const owner = process.env.WHATSAPP_OWNER_JID
  if (owner && topAccessed.length > 0) await sendWhatsApp(owner, summary).catch(() => {})

  logger.info({ topAccessed: topAccessed.length, topCoRetrievals: topCoRetrievals.length, promoted }, '[phase7] cross-session mining concluído')
  return { analyzed: topAccessed.length, coRetrievals: topCoRetrievals.length, promoted }
}
