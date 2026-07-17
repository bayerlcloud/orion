/**
 * Curator de Skills — mantém o catálogo de skills saudável.
 *
 * Ciclo:
 * 1. Backup JSON antes de qualquer alteração
 * 2. Marca skills como 'stale' (sem uso há 30 dias)
 * 3. Marca skills como 'archived' (stale há mais de 30 dias)
 * 4. Consulta Haiku para consolidar skills similares
 * 5. Aplica consolidações (umbrella + absorvidas) no SQLite
 * 6. Notifica via WhatsApp com resumo
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

// ── Backup JSON ───────────────────────────────────────────────────────────────

function backupSkills(db) {
  mkdirSync(BACKUP_DIR, { recursive: true })

  const skills = db.prepare('SELECT * FROM skills').all()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(BACKUP_DIR, `skills-${ts}.json`)

  writeFileSync(file, JSON.stringify({ ts, count: skills.length, skills }, null, 2), 'utf8')
  log.info({ file, count: skills.length }, '[curator] backup criado')

  // Manter apenas os últimos MAX_BACKUPS
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('skills-') && f.endsWith('.json'))
    .sort()

  if (files.length > MAX_BACKUPS) {
    const toDelete = files.slice(0, files.length - MAX_BACKUPS)
    for (const f of toDelete) {
      unlinkSync(join(BACKUP_DIR, f))
      log.info({ f }, '[curator] backup antigo removido')
    }
  }
}

// ── Staleness & archiving ─────────────────────────────────────────────────────

function markStale(db) {
  const threshold = Math.floor(Date.now() / 1000) - 30 * 86400
  const result = db.prepare(`
    UPDATE skills
    SET status = 'stale', updated_at = unixepoch()
    WHERE status = 'active'
      AND (
        (last_used_at IS NULL AND created_at < ?)
        OR (last_used_at < ?)
      )
  `).run(threshold, threshold)
  log.info({ changed: result.changes }, '[curator] skills marcadas stale')
  return result.changes
}

function markArchived(db) {
  const threshold = Math.floor(Date.now() / 1000) - 30 * 86400
  const result = db.prepare(`
    UPDATE skills
    SET status = 'archived', updated_at = unixepoch()
    WHERE status = 'stale'
      AND updated_at < ?
  `).run(threshold)
  log.info({ changed: result.changes }, '[curator] skills arquivadas')
  return result.changes
}

// ── Consolidação via Haiku ────────────────────────────────────────────────────

async function proposeConsolidations(skills) {
  if (skills.length < 2) return []

  const skillList = skills
    .map(s => `- "${s.name}" (uso:${s.usage_count} conf:${(s.confidence ?? 0).toFixed(2)}): ${(s.content ?? '').slice(0, 120).replace(/\n/g, ' ')}`)
    .join('\n')

  const prompt = `Analise estas skills de um assistente pessoal e identifique grupos de skills similares ou sobrepostas que podem ser consolidadas em uma skill guarda-chuva.

Skills ativas:
${skillList}

Retorne SOMENTE JSON válido (sem markdown, sem explicação) com:
{
  "consolidations": [
    {
      "umbrella_name": "nome conciso da skill unificada",
      "umbrella_description": "o que a skill unificada faz",
      "members": ["nome1", "nome2"]
    }
  ]
}

Regras:
- Só proponha consolidações quando as skills forem genuinamente similares (>70% sobreposição de propósito)
- Cada grupo deve ter pelo menos 2 membros
- Máximo 3 consolidações por execução
- Se não houver consolidações evidentes, retorne {"consolidations": []}`

  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', 'claude-haiku-4-5-20251001',
    ], { cwd: '/config/workspace', timeout: 60_000 })

    const parsed = JSON.parse(result.stdout)
    const text = parsed.result ?? parsed.content ?? ''

    // Extrair JSON da resposta (pode vir com markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []

    const data = JSON.parse(jsonMatch[0])
    return (data.consolidations ?? []).slice(0, 3)
  } catch (err) {
    log.warn({ err: err.message }, '[curator] erro ao consultar Haiku para consolidações')
    return []
  }
}

function applyConsolidations(db, consolidations, activeSkills) {
  const nameToSkill = Object.fromEntries(activeSkills.map(s => [s.name, s]))
  let applied = 0

  const upsertUmbrella = db.prepare(`
    INSERT INTO skills (name, description, content, usage_count, confidence, status, created_at, updated_at, last_used_at, source)
    VALUES (?, ?, ?, ?, ?, 'active', unixepoch(), unixepoch(), unixepoch(), 'curator')
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      content = excluded.content,
      usage_count = MAX(usage_count, excluded.usage_count),
      updated_at = unixepoch()
  `)

  const absorbMember = db.prepare(`
    UPDATE skills
    SET status = 'archived', absorbed_into = ?, updated_at = unixepoch()
    WHERE name = ? AND status != 'archived'
  `)

  for (const c of consolidations) {
    const members = (c.members ?? []).filter(m => nameToSkill[m])
    if (members.length < 2) continue

    // Agregar conteúdo e uso dos membros
    const memberSkills = members.map(m => nameToSkill[m]).filter(Boolean)
    const totalUsage = memberSkills.reduce((acc, s) => acc + (s.usage_count ?? 0), 0)
    const avgConf = memberSkills.reduce((acc, s) => acc + (s.confidence ?? 0.5), 0) / memberSkills.length
    const combinedContent = memberSkills.map(s => `### ${s.name}\n${s.content ?? ''}`).join('\n\n')

    upsertUmbrella.run(
      c.umbrella_name,
      c.umbrella_description ?? '',
      combinedContent,
      totalUsage,
      avgConf,
    )

    for (const memberName of members) {
      absorbMember.run(c.umbrella_name, memberName)
      log.info({ member: memberName, umbrella: c.umbrella_name }, '[curator] skill absorvida')
    }

    applied++
    log.info({ umbrella: c.umbrella_name, members }, '[curator] consolidação aplicada')
  }

  return applied
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runCurator() {
  log.info('[curator] iniciando ciclo')
  const db = getDb()

  // 1. Backup
  backupSkills(db)

  // 2. Stale e archive
  const markedStale = markStale(db)
  const markedArchived = markArchived(db)

  // 3. Consolidação das skills ainda ativas
  const activeSkills = db.prepare(`
    SELECT id, name, description, content, usage_count, confidence
    FROM skills
    WHERE status = 'active'
    ORDER BY usage_count DESC
    LIMIT 50
  `).all()

  let consolidated = 0
  if (activeSkills.length >= 2) {
    const proposals = await proposeConsolidations(activeSkills)
    consolidated = applyConsolidations(db, proposals, activeSkills)
  }

  // 4. Notificação WhatsApp
  const summary = [
    `🧹 *Curator de Skills — ${new Date().toLocaleDateString('pt-BR')}*`,
    `• Skills stale: ${markedStale}`,
    `• Skills arquivadas: ${markedArchived}`,
    `• Consolidações aplicadas: ${consolidated}`,
    `• Skills ativas: ${db.prepare("SELECT COUNT(*) as c FROM skills WHERE status='active'").get().c}`,
  ].join('\n')

  if (OWNER_JID) {
    await sendWhatsApp(OWNER_JID, summary).catch(err =>
      log.warn({ err: err.message }, '[curator] falha ao enviar WhatsApp')
    )
  }

  // 5. Aprendizado ativo — no MÁXIMO 1 pergunta proativa por ciclo (as guardas
  // internas limitam por categoria magra + intervalo). Vira card no chat web.
  // Regime de teste (lapidação 2026-07-09): se os cards forem dispensados sem
  // resposta por 2 semanas, remover a cadeia toda (active-learner + cards).
  try {
    const { checkAndQueueQuestion } = await import('../agent/active-learner.js')
    const recent = db.prepare(
      `SELECT content FROM memories WHERE archived = 0 ORDER BY created_at DESC LIMIT 3`
    ).all().map(r => r.content).join(' | ')
    checkAndQueueQuestion(recent)
  } catch (err) {
    log.warn({ err: err.message }, '[curator] active-learner falhou')
  }

  log.info({ markedStale, markedArchived, consolidated }, '[curator] ciclo concluído')
  return { ok: true, markedStale, markedArchived, consolidated }
}
