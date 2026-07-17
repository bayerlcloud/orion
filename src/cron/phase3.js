/**
 * Fase 3 — Consolidação profunda com Haiku (roda a cada 6h)
 * LLM barato (Haiku) faz: merge de clusters, detecção de contradições,
 * geração de skills, promoção para vault.
 */

import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { saveMemory } from '../memory/index.js'
import { scanContradictions } from '../memory/contradiction-scanner.js'
import { refreshAllCategorySummaries } from '../memory/tiered-summarizer.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const VAULT_PATH = '/config/workspace/notes/Orion/memoria/'
const MERGE_CONFIDENCE = 0.6     // episodic → candidato a merge
const SKILL_CONFIDENCE = 0.85    // semantic → skill → vault

async function callHaiku(prompt) {
  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 60_000 })
    const parsed = JSON.parse(result.stdout)
    return parsed.result ?? parsed.content ?? ''
  } catch (e) {
    console.error('[phase3] Haiku error:', e.message)
    return null
  }
}

function clusterByKeyword(memories, maxClusters = 10) {
  const clusters = []
  const used = new Set()

  for (const m of memories) {
    if (used.has(m.id)) continue
    const words = new Set(m.content.toLowerCase().split(/\s+/).filter(w => w.length > 4))
    const cluster = [m]
    used.add(m.id)

    for (const other of memories) {
      if (used.has(other.id)) continue
      const otherWords = new Set(other.content.toLowerCase().split(/\s+/).filter(w => w.length > 4))
      const shared = [...words].filter(w => otherWords.has(w)).length
      if (shared >= 2) {
        cluster.push(other)
        used.add(other.id)
      }
    }

    if (cluster.length >= 2) {
      clusters.push(cluster)
      if (clusters.length >= maxClusters) break
    }
  }

  return clusters
}

export async function runPhase3() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  let merged = 0, contradictions = 0, skills = 0, vaultWrites = 0

  // ── 1. Merge de clusters episódicos ─────────────────────────────────────────
  const candidates = db.prepare(`
    SELECT * FROM memories WHERE type = 'episodic' AND confidence >= ?
    ORDER BY confidence DESC LIMIT 100
  `).all(MERGE_CONFIDENCE)

  const clusters = clusterByKeyword(candidates)

  for (const cluster of clusters) {
    const contents = cluster.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
    const prompt = `Você é um sistema de memória. Analise estas memórias relacionadas e:
1. Mescle em UMA memória semântica concisa (máx 80 palavras)
2. Se houver contradição, indique com "CONTRADIÇÃO:" antes
3. Retorne APENAS a memória mesclada, sem explicação

Memórias:
${contents}`

    const merged_content = await callHaiku(prompt)
    if (!merged_content) continue

    const isContradiction = merged_content.startsWith('CONTRADIÇÃO:')
    const cleanContent = merged_content.replace(/^CONTRADIÇÃO:\s*/i, '')

    // Salvar memória semântica mesclada
    const avgConf = cluster.reduce((s, m) => s + m.confidence, 0) / cluster.length
    saveMemory({
      content: cleanContent,
      type: 'semantic',
      source: 'phase3',
      confidence: Math.min(0.9, avgConf + 0.1),
      sourceTool: 'phase3-merge',
    })

    // Deletar originais
    for (const m of cluster) {
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(m.id)
    }

    merged += cluster.length
    if (isContradiction) contradictions++
  }

  // ── 2. Promoção semantic → skill (confidence alta + muito acessado) ──────────
  const skillCandidates = db.prepare(`
    SELECT * FROM memories WHERE type = 'semantic'
    AND confidence >= ? AND access_count >= 3
    ORDER BY confidence DESC LIMIT 20
  `).all(SKILL_CONFIDENCE)

  for (const m of skillCandidates) {
    const prompt = `Converta esta memória em uma skill (procedimento reutilizável):
Memória: "${m.content}"

Formato: título curto (5 palavras max) + procedimento em bullets
Retorne apenas: TÍTULO\n- bullet1\n- bullet2`

    const skillContent = await callHaiku(prompt)
    if (!skillContent) continue

    const lines = skillContent.split('\n')
    const title = lines[0]?.trim()
    if (!title) continue

    db.prepare(`
      INSERT INTO skills (name, content, confidence, usage_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET content = excluded.content, confidence = MAX(confidence, excluded.confidence), updated_at = unixepoch()
    `).run(title, skillContent, m.confidence, m.access_count)

    db.prepare(`UPDATE memories SET type = 'skill', updated_at = ? WHERE id = ?`).run(now, m.id)
    skills++
  }

  // ── 3. Escrever skills de alta confiança no vault ─────────────────────────────
  const vaultSkills = db.prepare(`
    SELECT * FROM skills WHERE confidence >= 0.9 AND vault_path IS NULL
    ORDER BY usage_count DESC LIMIT 5
  `).all()

  mkdirSync(VAULT_PATH, { recursive: true })

  for (const skill of vaultSkills) {
    const slug = skill.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
    const vaultFile = join(VAULT_PATH, `${slug}.md`)
    const content = `---
name: ${skill.name}
confidence: ${skill.confidence}
usage_count: ${skill.usage_count}
generated: ${new Date().toISOString().slice(0, 10)}
---

${skill.content}
`
    writeFileSync(vaultFile, content, 'utf8')
    db.prepare(`UPDATE skills SET vault_path = ?, updated_at = ? WHERE id = ?`).run(vaultFile, now, skill.id)
    vaultWrites++
  }

  // ── 4. Varredura sistemática de contradições (pairwise) ──────────────────────
  let systematicContradictions = 0
  try {
    // Varre as categorias de maior consequência
    for (const cat of ['decision', 'person', 'project', 'user_pref']) {
      systematicContradictions += scanContradictions(cat, { limit: 80, threshold: 0.35 })
    }
  } catch (err) {
    console.warn('[phase3] contradiction scan erro:', err.message)
  }

  // ── Round 4: Tier 2 category summaries refresh (toda fase3, background) ───────
  setImmediate(() => {
    refreshAllCategorySummaries().catch(() => {})
  })

  console.log(`[phase3] merged:${merged} contradictions:${contradictions} systematic_contradictions:${systematicContradictions} skills:${skills} vault:${vaultWrites}`)
  return { merged, contradictions, systematicContradictions, skills, vaultWrites }
}
