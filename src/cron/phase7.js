/**
 * Fase 7 — Cross-session Pattern Mining (Semanal, domingo 23h)
 *
 * Analisa padrões de uso da memória ENTRE sessões:
 * - Tópicos mais recorrentes (tokens frequentes em queries)
 * - Memórias com co-retrieval alto (quais conceitos sempre andam juntos)
 * - Gaps de cobertura (categorias sub-representadas)
 * - Memórias órfãs (alto acesso, baixa confiança — candidatas à promoção)
 * - Consolidação de insights no vault
 */

import { getDb } from '../db/index.js'
import { execa } from 'execa'
import { sendWhatsApp } from '../gateway/evolution.js'
import { logger } from '../logger.js'
import { saveMemory } from '../memory/index.js'
import { writeFileSync } from 'node:fs'

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

  // ── 1. Top tópicos recorrentes (via access_count) ─────────────────────────
  const topAccessed = db.prepare(`
    SELECT id, content, category, access_count, confidence
    FROM memories
    WHERE archived = 0 AND last_accessed > ?
    ORDER BY access_count DESC
    LIMIT 30
  `).all(weekAgo)

  // ── 2. Top co-retrievals ──────────────────────────────────────────────────
  const topCoRetrievals = db.prepare(`
    SELECT id_a, id_b, count
    FROM co_retrievals
    ORDER BY count DESC
    LIMIT 20
  `).all()

  // ── 3. Gaps de cobertura — categorias sub-representadas ──────────────────
  const catStats = db.prepare(`
    SELECT category, COUNT(*) as cnt, AVG(confidence) as avg_conf
    FROM memories WHERE archived = 0
    GROUP BY category
    ORDER BY cnt DESC
  `).all()

  // ── 4. Memórias órfãs — alta frequência, baixa confiança ─────────────────
  const orphans = db.prepare(`
    SELECT id, content, category, access_count, confidence
    FROM memories
    WHERE archived = 0 AND access_count >= 5 AND confidence < 0.4
    ORDER BY access_count DESC
    LIMIT 10
  `).all()

  // Promover órfãos: se acesso alto, sinal de relevância — aumentar confiança
  let promoted = 0
  for (const m of orphans) {
    const boostConf = Math.min(0.7, m.confidence + 0.15)
    db.prepare(`UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?`)
      .run(boostConf, now, m.id)
    promoted++
  }

  // ── 5. Análise Haiku dos padrões ──────────────────────────────────────────
  if (topAccessed.length > 0) {
    const contentSample = topAccessed.slice(0, 10).map(m => `- [${m.category}] ${m.content.slice(0, 80)}`).join('\n')

    const analysisPrompt = `Analise estes fatos mais acessados da memória de um agente pessoal na última semana:
${contentSample}

Identificar:
1. Padrão temático principal (1 frase)
2. Domínio de conhecimento mais ativo (ex: infra, projetos, pessoal)
3. Possível gap: qual categoria de fato DEVERIA existir mas provavelmente não existe?
4. Sugestão: 1 fato sintético que resumiria os padrões observados (para salvar na memória)

Retorne JSON: {"theme": "...", "domain": "...", "gap": "...", "synthesis_fact": "..."}`

    const raw = await callHaiku(analysisPrompt)
    if (raw) {
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const analysis = JSON.parse(jsonMatch[0])

          // Salva fato sintético como memória semântica
          if (analysis.synthesis_fact && String(analysis.synthesis_fact).length > 20) {
            await saveMemory({
              content: `[pattern-mining] ${analysis.synthesis_fact}`,
              type: 'semantic',
              source: 'cron',
              category: 'general',
              confidence: 0.6,
              sourceTool: 'phase7-mining',
            })
          }

          // Salva análise no vault
          const vaultNote = `# Pattern Mining — ${new Date().toISOString().slice(0, 10)}

## Tema principal
${analysis.theme ?? 'N/A'}

## Domínio mais ativo
${analysis.domain ?? 'N/A'}

## Gap identificado
${analysis.gap ?? 'N/A'}

## Fato sintético gerado
${analysis.synthesis_fact ?? 'N/A'}

## Estatísticas
- Memórias analisadas: ${topAccessed.length}
- Co-retrievals rastreados: ${topCoRetrievals.length}
- Memórias promovidas (conf↑): ${promoted}
- Distribuição por categoria: ${catStats.map(c => `${c.category}=${c.cnt}`).join(', ')}
`
          try {
            writeFileSync(
              `/config/workspace/notes/Orion/memoria/pattern-mining-${new Date().toISOString().slice(0, 10)}.md`,
              vaultNote, 'utf8'
            )
          } catch { /* vault pode não estar disponível */ }
        }
      } catch { /* ignora parse error */ }
    }
  }

  // ── 6. Relatório WhatsApp ─────────────────────────────────────────────────
  const summary = `🔬 *Pattern Mining semanal*\n📊 ${topAccessed.length} memórias analisadas\n🔗 ${topCoRetrievals.length} co-retrievals\n🌱 ${promoted} memórias promovidas\n📁 ${catStats.length} categorias`
  const owner = process.env.WHATSAPP_OWNER_JID
  if (owner && topAccessed.length > 0) {
    await sendWhatsApp(owner, summary).catch(() => {})
  }

  logger.info({ topAccessed: topAccessed.length, topCoRetrievals: topCoRetrievals.length, promoted }, '[phase7] cross-session mining concluído')
  return { analyzed: topAccessed.length, coRetrievals: topCoRetrievals.length, promoted }
}
