/**
 * Curator de Skills — mantém o catálogo de skills saudável.
 */

import { writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { sendWhatsApp } from '../gateway/evolution.js'
import { createLogger } from '../logger.js'

const log = createLogger('curator')
const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = join(__dirname, '../../data/skill-backups')
const MAX_BACKUPS = 10
const OWNER_JID = process.env.WHATSAPP_OWNER_JID ?? ''

function backupSkills(db) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  const skills = db.prepare('SELECT * FROM skills').all()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(BACKUP_DIR, `skills-${ts}.json`)
  writeFileSync(file, JSON.stringify({ ts, count: skills.length, skills }, null, 2), 'utf8')
  log.info({ file, count: skills.length }, '[curator] backup criado')
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('skills-') && f.endsWith('.json'))
    .sort()
  if (files.length > MAX_BACKUPS) {
    const toDelete = files.slice(0, files.length - MAX_BACKUPS)
    for (const f of toDelete) { unlinkSync(join(BACKUP_DIR, f)); log.info({ f }, '[curator] backup antigo removido') }
  }
}

function markStale(db) {
  const threshold = Math.floor(Date.now() / 1000) - 30 * 86400
  const result = db.prepare(`
    UPDATE skills SET status = 'stale', updated_at = unixepoch()
    WHERE status = 'active' AND ((last_used_at IS NULL AND created_at < ?) OR (last_used_at < ?))
  `).run(threshold, threshold)
  return result.changes
}

function markArchived(db) {
  const threshold = Math.floor(Date.now() / 1000) - 30 * 86400
  return db.prepare(`UPDATE skills SET status = 'archived', updated_at = unixepoch() WHERE status = 'stale' AND updated_at < ?`).run(threshold).changes
}

async function proposeConsolidations(skills) {
  if (skills.length < 2) return []
  const skillList = skills
    .map(s => `- "${s.name}" (uso:${s.usage_count} conf:${(s.confidence ?? 0).toFixed(2)}): ${(s.content ?? '').slice(0, 120).replace(/\n/g, ' ')}`)
    .join('\n')
  const prompt = `Analise estas skills de um assistente pessoal e identifique grupos de skills similares ou sobrepostas que podem ser consolidadas em uma skill guarda-chuva.

Skills ativas:
${skillList}

Retorne SOMENTE JSON válido:
{
  "consolidations": [
    {
      "umbrella_name": "nome conciso da skill unificada",
      "umbrella_description": "o que a skill unificada faz",
      "members": ["nome1", "nome2"]
    }
  ]
}

Regras: só proponha quando as skills forem genuinamente similares (>70% sobreposição), cada grupo com pelo menos 2 membros, máximo 3 consolidações. Se não houver, retorne {"consolidations": []}`
  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', 'claude-haiku-4-5-20251001',
    ], { cwd: process.cwd(), timeout: 60_000 })
    const parsed = JSON.parse(result.stdout)
    const text = parsed.result ?? parsed.content ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []
    const data = JSON.parse(jsonMatch[0])
    return (data.consolidations ?? []).slice(0, 3)
  } catch (err) {
    log.warn({ err: err.message }, '[curator] erro ao consultar Haiku')
    return []
  }
}

function applyConsolidations(db, consolidations, activeSkills) {
  const nameToSkill = Object.fromEntries(activeSkills.map(s => [s.name, s]))
  let applied = 0
  const upsertUmbrella = db.prepare(`
    INSERT INTO skills (name, description, content, usage_count, confidence, status, created_at, updated_at, last_used_at, source)
    VALUES (?, ?, ?, ?, ?, 'active', unixepoch(), unixepoch(), unixepoch(), 'curator')
    ON CONFLICT(name) DO UPDATE SET description=excluded.description, content=excluded.content, usage_count=MAX(usage_count,excluded.usage_count), updated_at=unixepoch()
  `)
  const absorbMember = db.prepare(`UPDATE skills SET status='archived', absorbed_into=?, updated_at=unixepoch() WHERE name=? AND status!='archived'`)
  for (const c of consolidations) {
    const members = (c.members ?? []).filter(m => nameToSkill[m])
    if (members.length < 2) continue
    const memberSkills = members.map(m => nameToSkill[m]).filter(Boolean)
    const totalUsage = memberSkills.reduce((acc, s) => acc + (s.usage_count ?? 0), 0)
    const avgConf = memberSkills.reduce((acc, s) => acc + (s.confidence ?? 0.5), 0) / memberSkills.length
    const combinedContent = memberSkills.map(s => `### ${s.name}\n${s.content ?? ''}`).join('\n\n')
    upsertUmbrella.run(c.umbrella_name, c.umbrella_description ?? '', combinedContent, totalUsage, avgConf)
    for (const memberName of members) { absorbMember.run(c.umbrella_name, memberName) }
    applied++
  }
  return applied
}

export async function runCurator() {
  log.info('[curator] iniciando ciclo')
  const db = getDb()
  backupSkills(db)
  const markedStale = markStale(db)
  const markedArchived = markArchived(db)
  const activeSkills = db.prepare(`SELECT id, name, description, content, usage_count, confidence FROM skills WHERE status='active' ORDER BY usage_count DESC LIMIT 50`).all()
  let consolidated = 0
  if (activeSkills.length >= 2) {
    const proposals = await proposeConsolidations(activeSkills)
    consolidated = applyConsolidations(db, proposals, activeSkills)
  }
  const summary = [
    `🧹 *Curator de Skills — ${new Date().toLocaleDateString('pt-BR')}*`,
    `• Skills stale: ${markedStale}`,
    `• Skills arquivadas: ${markedArchived}`,
    `• Consolidações aplicadas: ${consolidated}`,
    `• Skills ativas: ${db.prepare("SELECT COUNT(*) as c FROM skills WHERE status='active'").get().c}`,
  ].join('\n')
  if (OWNER_JID) await sendWhatsApp(OWNER_JID, summary).catch(() => {})
  try {
    const { checkAndQueueQuestion } = await import('../agent/active-learner.js')
    const recent = db.prepare(`SELECT content FROM memories WHERE archived=0 ORDER BY created_at DESC LIMIT 3`).all().map(r => r.content).join(' | ')
    checkAndQueueQuestion(recent)
  } catch (err) { log.warn({ err: err.message }, '[curator] active-learner falhou') }
  log.info({ markedStale, markedArchived, consolidated }, '[curator] ciclo concluído')
  return { ok: true, markedStale, markedArchived, consolidated }
}
