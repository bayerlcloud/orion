/**
 * Cron Manager — paridade total com Hermes.
 *
 * Schedule kinds: cron expr | every Xm/Xh/Xd | once (delay relativo ou ISO timestamp)
 * Execução: script pre-run → wake-gate → no_agent → prompt enriquecido → claude CLI
 * Extras: [SILENT], context_from, model override, repeat_n, skip_if_recent, workdir,
 *         deliver multi-plataforma, state machine, prompt injection defense, heartbeat
 */

import cron from 'node-cron'
import { execa } from 'execa'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import path from 'path'
import { getDb } from '../db/index.js'
import { logger } from '../logger.js'
import { resolveTargets, deliverResult } from './delivery.js'
import { sendToSession } from '../sessions/sender.js'

const execFileAsync = promisify(execFile)

const SCRIPTS_DIR  = path.resolve('/config/workspace/orion/scripts')
const HEARTBEAT    = path.resolve('/config/workspace/orion/data/cron-heartbeat')
const SILENT_MARKER = '[SILENT]'
const SCRIPT_TIMEOUT_MS = 60_000
const JOB_TIMEOUT_MS    = 180_000  // 3 min hard limit (Hermes parity)

// id → { task: cron.ScheduledTask | null, timer: NodeJS.Timeout | null }
const activeJobs = new Map()

// ── Schedule parsing ──────────────────────────────────────────────────────────

const INTERVAL_RE = /^every\s+(\d+)\s*(m(?:in(?:utos?)?)?|h(?:oras?)?|d(?:ia[s]?)?)$/i
const DELAY_RE    = /^(\d+)\s*(m(?:in(?:utos?)?)?|h(?:oras?)?|d(?:ia[s]?)?)$/i

function _unitToMinutes(value, unit) {
  const n = parseInt(value, 10)
  const u = unit[0].toLowerCase()
  if (u === 'm') return n
  if (u === 'h') return n * 60
  if (u === 'd') return n * 1440
  return n
}

function _intervalToCron(minutes) {
  if (minutes < 60)  return `*/${minutes} * * * *`
  if (minutes < 1440) return `0 */${Math.round(minutes / 60)} * * *`
  return `0 0 */${Math.round(minutes / 1440)} * *`
}

/**
 * Retorna { kind, schedule, intervalMinutes, fireAt, display }
 * kind: 'cron' | 'interval' | 'once'
 */
export function parseScheduleAdvanced(text) {
  const t = text.trim()

  // ISO timestamp → once
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const d = new Date(t)
    if (!isNaN(d)) {
      return { kind: 'once', schedule: null, intervalMinutes: null, fireAt: Math.floor(d.getTime() / 1000), display: `uma vez em ${d.toLocaleString('pt-BR')}` }
    }
  }

  // "every Xm/h/d" → interval
  const im = t.match(INTERVAL_RE)
  if (im) {
    const mins = _unitToMinutes(im[1], im[2])
    const cronExpr = _intervalToCron(mins)
    return { kind: 'interval', schedule: cronExpr, intervalMinutes: mins, fireAt: null, display: `a cada ${im[1]}${im[2][0].toLowerCase()}` }
  }

  // "Xm/h/d" → once (delay relativo)
  const dm = t.match(DELAY_RE)
  if (dm) {
    const mins = _unitToMinutes(dm[1], dm[2])
    const fireAt = Math.floor(Date.now() / 1000) + mins * 60
    return { kind: 'once', schedule: null, intervalMinutes: null, fireAt, display: `uma vez em ${dm[1]}${dm[2][0]}` }
  }

  // Expressão cron padrão
  if (cron.validate(t)) {
    return { kind: 'cron', schedule: t, intervalMinutes: null, fireAt: null, display: t }
  }

  // Linguagem natural PT-BR → cron expr
  const nlCron = parseNaturalCron(t)
  if (nlCron) {
    return { kind: 'cron', schedule: nlCron, intervalMinutes: null, fireAt: null, display: t }
  }

  return null
}

const NL_PATTERNS = [
  { re: /todo[as]?\s+dia[s]?\s+[àaas]+\s+(\d{1,2})h?(?::(\d{2}))?/i,
    fn: (m) => `${m[2] ?? '0'} ${m[1]} * * *` },
  { re: /todo[as]?\s+hora[s]?/i,      fn: () => '0 * * * *' },
  { re: /a\s+cada\s+(\d+)\s+hora[s]?/i, fn: (m) => `0 */${m[1]} * * *` },
  { re: /a\s+cada\s+(\d+)\s+minuto[s]?/i, fn: (m) => `*/${m[1]} * * * *` },
  { re: /toda[s]?\s+segunda/i,         fn: () => '0 9 * * 1' },
  { re: /toda[s]?\s+ter[cç]a/i,        fn: () => '0 9 * * 2' },
  { re: /toda[s]?\s+quarta/i,          fn: () => '0 9 * * 3' },
  { re: /toda[s]?\s+quinta/i,          fn: () => '0 9 * * 4' },
  { re: /toda[s]?\s+sexta/i,           fn: () => '0 9 * * 5' },
  { re: /toda[s]?\s+semana/i,          fn: () => '0 9 * * 1' },
  { re: /todo[s]?\s+m[eê]s/i,          fn: () => '0 9 1 * *' },
  { re: /dia[s]?\s+[úu]tei[s]/i,       fn: () => '0 9 * * 1-5' },
  { re: /fim\s+de\s+semana/i,           fn: () => '0 9 * * 6,0' },
]

export function parseNaturalCron(text) {
  for (const { re, fn } of NL_PATTERNS) {
    const m = text.match(re)
    if (m) return fn(m)
  }
  return null
}

// ── Prompt injection defense ──────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /cat\s+.*\.(env|key|pem|secret)/i,
  /rm\s+-rf/i,
  /authorized_keys/i,
  /curl\s+.*\|\s*(?:bash|sh)/i,
  /wget\s+.*\|\s*(?:bash|sh)/i,
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /você\s+(?:deve|precisa)\s+(?:ignorar|esquecer)/i,
  /forget\s+(?:all\s+)?previous/i,
  /​|‌|‍|﻿/,  // invisible unicode
]

export function scanPromptForInjection(prompt) {
  if (!prompt) return null
  for (const re of INJECTION_PATTERNS) {
    if (re.test(prompt)) return `padrão suspeito detectado: ${re.source.slice(0, 60)}`
  }
  return null
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createJob({
  name, description, schedule: scheduleRaw, taskPrompt, tools = [], createdBy = 'orion',
  script = null, noAgent = false, model = null, contextFrom = [],
  skipIfRecent = null, repeatN = null,
  deliver = 'whatsapp', origin = null, workdir = null, targetSession = null,
}) {
  // Injection defense
  const injectionHit = scanPromptForInjection(taskPrompt)
  if (injectionHit) {
    logger.warn({ injectionHit }, 'cron: prompt bloqueado por injection defense')
    throw new Error(`Prompt bloqueado: ${injectionHit}`)
  }

  const parsed = parseScheduleAdvanced(scheduleRaw)
  if (!parsed) throw new Error(`Schedule inválido: ${scheduleRaw}`)

  const db = getDb()
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  db.prepare(`
    INSERT INTO cron_jobs (
      id, name, description, schedule, schedule_kind, interval_minutes, fire_at,
      task_prompt, tools, status, state, created_by,
      script, no_agent, model, context_from, skip_if_recent, repeat_n,
      deliver, origin, workdir, target_session
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, description,
    parsed.schedule ?? scheduleRaw,
    parsed.kind, parsed.intervalMinutes, parsed.fireAt,
    taskPrompt, JSON.stringify(tools), createdBy,
    script, noAgent ? 1 : 0, model,
    JSON.stringify(contextFrom), skipIfRecent, repeatN,
    deliver, origin ? JSON.stringify(origin) : null, workdir, targetSession,
  )

  _scheduleJob({
    id, name,
    schedule: parsed.schedule, schedule_kind: parsed.kind,
    interval_minutes: parsed.intervalMinutes, fire_at: parsed.fireAt,
    task_prompt: taskPrompt, script,
    no_agent: noAgent ? 1 : 0, model,
    context_from: JSON.stringify(contextFrom),
    skip_if_recent: skipIfRecent, repeat_n: repeatN,
    deliver, origin: origin ? JSON.stringify(origin) : null, workdir,
    target_session: targetSession,
    last_run: null, run_count: 0,
  })

  logger.info({ jobId: id, name, schedule: parsed.display }, 'cron job criado')
  return id
}

export function pauseJob(id, reason = null) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`UPDATE cron_jobs SET status = 'paused', state = 'paused', paused_at = ?, paused_reason = ? WHERE id = ?`)
    .run(now, reason, id)
  const entry = activeJobs.get(id)
  if (entry?.task) entry.task.stop()
  if (entry?.timer) clearTimeout(entry.timer)
  logger.info({ jobId: id }, 'cron job pausado')
}

export function resumeJob(id) {
  const db = getDb()
  const job = db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`).get(id)
  if (!job) return
  db.prepare(`UPDATE cron_jobs SET status = 'active', state = 'scheduled', paused_at = NULL, paused_reason = NULL WHERE id = ?`).run(id)
  _scheduleJob(job)
  logger.info({ jobId: id }, 'cron job resumido')
}

export function deleteJob(id) {
  const db = getDb()
  db.prepare(`UPDATE cron_jobs SET status = 'deleted', state = 'completed' WHERE id = ?`).run(id)
  const entry = activeJobs.get(id)
  if (entry?.task) entry.task.stop()
  if (entry?.timer) clearTimeout(entry.timer)
  activeJobs.delete(id)
  logger.info({ jobId: id }, 'cron job deletado')
}

export function listJobs() {
  return getDb().prepare(`SELECT * FROM cron_jobs WHERE status != 'deleted' ORDER BY created_at DESC`).all()
}

export function getJobOutput(jobId, limit = 20) {
  return getDb().prepare(`
    SELECT * FROM cron_output WHERE job_id = ? ORDER BY ran_at DESC LIMIT ?
  `).all(jobId, Math.min(limit, 100))
}

export function getJobById(id) {
  return getDb().prepare(`SELECT * FROM cron_jobs WHERE id = ?`).get(id)
}

export async function triggerJob(id) {
  const db = getDb()
  const job = db.prepare(`SELECT * FROM cron_jobs WHERE id = ? AND status != 'deleted'`).get(id)
  if (!job) throw new Error('Job não encontrado')
  logger.info({ jobId: id }, 'cron trigger manual')
  await executeJob(job)
}

// ── Criação a partir de linguagem natural ─────────────────────────────────────

export function createJobFromNL(text, taskPrompt, createdBy = 'whatsapp') {
  const parsed = parseScheduleAdvanced(text)
  if (!parsed) return null
  const name = taskPrompt.slice(0, 50)
  const id = createJob({ name, description: text, schedule: text, taskPrompt, createdBy })
  return { id, schedule: parsed.display }
}

// ── Script pre-run ────────────────────────────────────────────────────────────

async function _runScript(scriptPath, workdir) {
  const resolved = path.resolve(SCRIPTS_DIR, scriptPath)
  if (!resolved.startsWith(SCRIPTS_DIR)) throw new Error(`Script fora do diretório: ${scriptPath}`)
  if (!existsSync(resolved)) throw new Error(`Script não encontrado: ${resolved}`)

  const ext = path.extname(resolved).toLowerCase()
  const [cmd, args] = ext === '.py' ? ['python3', [resolved]] : ['/bin/bash', [resolved]]

  const { stdout } = await execFileAsync(cmd, args, {
    timeout: SCRIPT_TIMEOUT_MS,
    cwd: workdir ?? SCRIPTS_DIR,
    env: { ...process.env, ORION_CRON: '1' },
  })
  return (stdout || '').trim()
}

function _checkWakeGate(output) {
  if (!output) return true
  const last = output.trim().split('\n').pop().trim()
  try { return JSON.parse(last)?.wakeAgent !== false } catch { return true }
}

// ── Context injection ─────────────────────────────────────────────────────────

function _loadContextFrom(jobIds) {
  if (!jobIds?.length) return ''
  const db = getDb()
  const parts = []
  for (const id of jobIds) {
    if (!/^[a-f0-9-]{32,36}$/.test(id)) continue
    const row = db.prepare(`SELECT output FROM cron_output WHERE job_id = ? AND status = 'ok' ORDER BY ran_at DESC LIMIT 1`).get(id)
    if (!row?.output) continue
    const jobRow = db.prepare(`SELECT name FROM cron_jobs WHERE id = ?`).get(id)
    parts.push(`## Output de "${jobRow?.name ?? id}"\n\n${row.output.slice(0, 4000)}`)
  }
  if (!parts.length) return ''
  return `\n\n---\n# Contexto de jobs anteriores\n\n${parts.join('\n\n---\n\n')}`
}

// ── Execução principal ────────────────────────────────────────────────────────

async function executeJob(job) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  // skip_if_recent
  if (job.skip_if_recent && job.last_run) {
    if ((now - job.last_run) < job.skip_if_recent) {
      logger.info({ jobId: job.id }, 'cron skip_if_recent: ignorando')
      return
    }
  }

  // Marcar como running
  db.prepare(`UPDATE cron_jobs SET state = 'running' WHERE id = ?`).run(job.id)

  let scriptOutput = null
  let finalOutput  = null
  let status       = 'ok'
  let deliveryErr  = null

  // Parse origin para delivery
  let origin = null
  try { origin = job.origin ? JSON.parse(job.origin) : null } catch {}

  try {
    // ── 1. Script pre-run ─────────────────────────────────────────────────────
    if (job.script) {
      try {
        scriptOutput = await _runScript(job.script, job.workdir)
        logger.info({ jobId: job.id, len: scriptOutput?.length }, 'cron script OK')
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'cron script erro')
        scriptOutput = `[Script error: ${err.message}]`
      }

      // Wake-gate
      if (!_checkWakeGate(scriptOutput)) {
        logger.info({ jobId: job.id }, 'cron wake-gate: silenciando')
        status = 'silent'
        _saveOutput(db, job.id, status, SILENT_MARKER, null, null)
        _updateJob(db, job.id, now, status, SILENT_MARKER, null)
        db.prepare(`UPDATE cron_jobs SET state = 'completed' WHERE id = ?`).run(job.id)
        return
      }
    }

    // ── 2. no_agent mode ──────────────────────────────────────────────────────
    if (job.no_agent) {
      finalOutput = scriptOutput ?? ''
      status = 'ok'
      _saveOutput(db, job.id, status, finalOutput, null, null)
      if (finalOutput) {
        const targets = resolveTargets(job.deliver, origin)
        deliveryErr = await deliverResult(targets, job.name, job.id, finalOutput)
      }
      _updateJob(db, job.id, now, status, finalOutput, deliveryErr)
      db.prepare(`UPDATE cron_jobs SET state = 'completed' WHERE id = ?`).run(job.id)
      return
    }

    // ── 2.5. Sessão-alvo: INJETA na sessão Claude Code (não spawna claude pelado) ─
    // A inteligência já está DENTRO da sessão-alvo (tem todo o contexto dela).
    // Só precisamos entregar a "tecla" — sendToSession faz claude --resume <uuid>.
    // É isso que faz "automação que cutuca a sessão X" funcionar de verdade.
    if (job.target_session) {
      let injectMsg = job.task_prompt
      if (scriptOutput) {
        injectMsg = `## Dados coletados pelo script\n\n\`\`\`\n${scriptOutput}\n\`\`\`\n\n---\n\n${injectMsg}`
      }
      logger.info({ jobId: job.id, session: job.target_session }, 'cron: injetando em sessão')
      finalOutput = await sendToSession(job.target_session, injectMsg, job.model)
      status = 'ok'
      _saveOutput(db, job.id, status, finalOutput, null, job.model)
      // Entrega opcional do que a sessão respondeu (se deliver != none)
      if (finalOutput && job.deliver && job.deliver !== 'none') {
        const targets = resolveTargets(job.deliver, origin)
        deliveryErr = await deliverResult(targets, job.name, job.id, finalOutput)
      }
      _updateJob(db, job.id, now, status, finalOutput, deliveryErr)
      db.prepare(`UPDATE cron_jobs SET state = 'completed' WHERE id = ?`).run(job.id)
      return
    }

    // ── 3. Montar prompt ──────────────────────────────────────────────────────
    let contextFrom = []
    try { contextFrom = JSON.parse(job.context_from ?? '[]') } catch {}

    let prompt = job.task_prompt
    if (scriptOutput) {
      prompt = `## Dados coletados pelo script\n\n\`\`\`\n${scriptOutput}\n\`\`\`\n\n---\n\n${prompt}`
    }
    const ctxSection = _loadContextFrom(contextFrom)
    if (ctxSection) prompt += ctxSection

    // ── 4. claude CLI ─────────────────────────────────────────────────────────
    const model = job.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
    const claudeArgs = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions', '--model', model]
    const execOpts = {
      cwd: job.workdir ?? '/config/workspace',
      env: job.workdir
        ? { ...process.env, TERMINAL_CWD: job.workdir }
        : process.env,
    }

    const claudeProc = execa('claude', claudeArgs, execOpts)
    const hardKill = new Promise((_, reject) =>
      setTimeout(() => {
        claudeProc.kill('SIGTERM')
        reject(new Error(`Job timeout após ${JOB_TIMEOUT_MS / 60000}min`))
      }, JOB_TIMEOUT_MS)
    )
    const result = await Promise.race([claudeProc, hardKill])
    const parsed = JSON.parse(result.stdout)
    finalOutput = (parsed.result ?? parsed.content ?? '').trim()

    // ── 5. [SILENT] marker ────────────────────────────────────────────────────
    if (finalOutput.toUpperCase().includes(SILENT_MARKER)) {
      logger.info({ jobId: job.id }, 'cron [SILENT]: sem entrega')
      status = 'silent'
      _saveOutput(db, job.id, status, finalOutput, null, model)
      _updateJob(db, job.id, now, status, finalOutput, null)
      db.prepare(`UPDATE cron_jobs SET state = 'completed' WHERE id = ?`).run(job.id)
      return
    }

    // ── 6. Entregar ───────────────────────────────────────────────────────────
    status = 'ok'
    _saveOutput(db, job.id, status, finalOutput, null, model)

    if (finalOutput) {
      const targets = resolveTargets(job.deliver, origin)
      deliveryErr = await deliverResult(targets, job.name, job.id, finalOutput)
      if (deliveryErr) logger.warn({ jobId: job.id, deliveryErr }, 'cron entrega com erro')
    }

    _updateJob(db, job.id, now, status, finalOutput, deliveryErr)
    db.prepare(`UPDATE cron_jobs SET state = 'completed' WHERE id = ?`).run(job.id)

  } catch (err) {
    logger.error({ err, jobId: job.id }, 'cron job falhou')
    status = 'failed'
    _saveOutput(db, job.id, status, null, err.message, null)
    _updateJob(db, job.id, now, status, null, null)
    db.prepare(`UPDATE cron_jobs SET state = 'error' WHERE id = ?`).run(job.id)

    // Tenta notificar o owner mesmo em falha
    try {
      const targets = resolveTargets(job.deliver, origin)
      const hint = _classifyError(err.message)
      await deliverResult(targets, job.name, job.id, `⚠️ Job falhou: ${hint}`)
    } catch {}
  }

  // ── 7. repeat_n — auto-pausa após N runs ─────────────────────────────────
  if (job.repeat_n != null) {
    const row = db.prepare(`SELECT run_count FROM cron_jobs WHERE id = ?`).get(job.id)
    if (row && row.run_count >= job.repeat_n) {
      logger.info({ jobId: job.id }, 'cron repeat_n atingido: pausando')
      pauseJob(job.id, `repeat_n=${job.repeat_n} atingido`)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _saveOutput(db, jobId, status, output, error, model) {
  db.prepare(`INSERT INTO cron_output (job_id, status, output, error, model_used) VALUES (?, ?, ?, ?, ?)`)
    .run(jobId, status, output ?? null, error ?? null, model ?? null)
}

function _updateJob(db, jobId, now, status, output, deliveryErr) {
  db.prepare(`
    UPDATE cron_jobs
    SET last_run = ?, run_count = run_count + 1, last_status = ?,
        last_output = ?, last_delivery_error = ?
    WHERE id = ?
  `).run(now, status, output ? output.slice(0, 2000) : null, deliveryErr ?? null, jobId)
}

function _classifyError(msg) {
  if (/429|rate.?limit|quota/i.test(msg))       return 'rate limit da API'
  if (/timed?.?out|ETIMEDOUT/i.test(msg))        return 'timeout'
  if (/401|403|authenticat|authoriz/i.test(msg)) return 'erro de autenticação'
  return msg.slice(0, 120)
}

// ── Agendamento ───────────────────────────────────────────────────────────────

function _scheduleJob(job) {
  // Limpa entrada anterior
  const prev = activeJobs.get(job.id)
  if (prev?.task)  prev.task.stop()
  if (prev?.timer) clearTimeout(prev.timer)

  const entry = { task: null, timer: null }
  activeJobs.set(job.id, entry)

  if (job.schedule_kind === 'once' || (!job.schedule && job.fire_at)) {
    // One-shot: setTimeout até fire_at
    const nowSec = Math.floor(Date.now() / 1000)
    const delayMs = Math.max(0, (job.fire_at - nowSec) * 1000)
    entry.timer = setTimeout(async () => {
      // Re-busca o row completo (garante target_session e todos os campos frescos)
      await executeJob(getJobById(job.id) || job)
      // Marcar como completed após rodar
      const db = getDb()
      db.prepare(`UPDATE cron_jobs SET status = 'deleted', state = 'completed' WHERE id = ?`).run(job.id)
      activeJobs.delete(job.id)
    }, delayMs)
    logger.info({ jobId: job.id, delayMs: Math.round(delayMs / 1000) + 's' }, 'cron one-shot agendado')
    return
  }

  if (!job.schedule || !cron.validate(job.schedule)) {
    logger.warn({ jobId: job.id, schedule: job.schedule }, 'cron: expressão inválida, ignorando')
    return
  }

  entry.task = cron.schedule(job.schedule, () => executeJob(getJobById(job.id) || job), { timezone: 'America/Sao_Paulo' })
  logger.info({ jobId: job.id, name: job.name, schedule: job.schedule }, 'cron agendado')
}

// ── Grace window — evita burst-fire no boot ───────────────────────────────────

function _estimateIntervalSecs(job) {
  if (job.schedule_kind === 'interval' && job.interval_minutes)
    return job.interval_minutes * 60
  if (!job.schedule) return null
  const parts = job.schedule.split(/\s+/)
  if (parts.length < 5) return null
  const [min, hour] = parts
  if (min.startsWith('*/'))  return parseInt(min.slice(2)) * 60
  if (hour.startsWith('*/')) return parseInt(hour.slice(2)) * 3600
  if (hour === '*') return 3600
  return 86400
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

async function _writeHeartbeat() {
  try {
    await writeFile(HEARTBEAT, String(Math.floor(Date.now() / 1000)), 'utf8')
  } catch {}
}

// ── Inicialização ─────────────────────────────────────────────────────────────

export function initCronJobs() {
  const db = getDb()
  const jobs = db.prepare(`SELECT * FROM cron_jobs WHERE status = 'active'`).all()
  const now = Math.floor(Date.now() / 1000)
  const GRACE = 120  // 2 min: se atrasado > grace, não burst-fica

  for (const job of jobs) {
    // Se foi one-shot e fire_at já passou, pula
    if (job.schedule_kind === 'once' && job.fire_at && job.fire_at < now - GRACE) {
      logger.info({ jobId: job.id }, 'cron one-shot expirado, ignorando')
      db.prepare(`UPDATE cron_jobs SET state = 'completed', status = 'deleted' WHERE id = ?`).run(job.id)
      continue
    }
    _scheduleJob(job)
  }

  logger.info({ count: jobs.length }, 'cron jobs carregados')
  _writeHeartbeat()
}

// ── Overdue checker (chamado periodicamente) ──────────────────────────────────

export function checkAndRunOverdueJobs() {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const jobs = db.prepare(`SELECT * FROM cron_jobs WHERE status = 'active' AND last_run IS NOT NULL`).all()

  for (const job of jobs) {
    if (job.schedule_kind === 'once') continue  // one-shots não se repetem
    const interval = _estimateIntervalSecs(job)
    if (!interval) continue
    const elapsed = now - job.last_run
    // Grace: max(120s, min(interval/2, 7200s))
    const grace = Math.max(120, Math.min(interval / 2, 7200))
    if (elapsed > interval + grace) {
      logger.info({ jobId: job.id, elapsedMin: Math.round(elapsed / 60) }, 'cron curator: job atrasado, disparando')
      executeJob(job).catch(() => {})
    }
  }

  _writeHeartbeat()
}
