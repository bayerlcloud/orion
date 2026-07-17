import { execa } from 'execa'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
import { createBoard, addTask, dispatch, getBoardStatus, getBoardTasks } from '../kanban/index.js'
import { recoverStaleTasks, cascadeFailures } from '../kanban/store.js'

const logger = createLogger('mission')
const HAIKU = 'claude-haiku-4-5-20251001'
const POLL_MS = 8_000
const MAX_WAIT_MS = 30 * 60 * 1000

async function planMission(goal) {
  const prompt = `Quebre este objetivo em 4-8 subtarefas concretas.\n\nObjetivo: ${goal}\n\nRetorne APENAS um array JSON. Cada item: {"title": string, "description": string, "dependsOn": number[]}\n"dependsOn" contém índices 0-base de tarefas que devem terminar primeiro.\nRetorne somente o array JSON.`
  const res = await execa('claude', ['-p', prompt, '--output-format', 'json', '--model', HAIKU, '--dangerously-skip-permissions'], { cwd: '/config/workspace', timeout: 60_000 })
  const parsed = JSON.parse(res.stdout)
  const raw = (parsed.result ?? parsed.content ?? res.stdout).trim()
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('Plano inválido')
  return JSON.parse(match[0])
}

async function aggregateResults(goal, tasks) {
  const parts = tasks.map(t => `### ${t.title}\nStatus: ${t.status}\n${t.result ?? t.error ?? '(sem resultado)'}`).join('\n\n')
  const prompt = `Compile os resultados das subtarefas em um relatório final coerente em português.\n\nObjetivo: ${goal}\n\nSubtarefas:\n${parts}\n\nEscreva o relatório final.`
  const res = await execa('claude', ['-p', prompt, '--output-format', 'json', '--model', HAIKU, '--dangerously-skip-permissions'], { cwd: '/config/workspace', timeout: 120_000 })
  const parsed = JSON.parse(res.stdout)
  return (parsed.result ?? parsed.content ?? res.stdout).trim()
}

async function notifyWhatsApp(goal, report, failed = false) {
  try {
    const { sendWhatsApp } = await import('../gateway/evolution.js')
    const jid = process.env.WHATSAPP_OWNER_JID
    if (!jid) return
    const header = failed
      ? `*⚠️ Missão falhou (timeout)*\n*Objetivo:* ${goal}`
      : `*✅ Missão concluída*\n*Objetivo:* ${goal}\n\n${report?.slice(0, 3500) ?? ''}`
    await sendWhatsApp(jid, header)
  } catch {}
}

async function finalizeMission(missionId, boardId, goal) {
  const db = getDb()
  const tasks = getBoardTasks(boardId)
  let report
  try { report = await aggregateResults(goal, tasks) }
  catch (err) { report = tasks.map(t => `${t.title}: ${t.result ?? t.error ?? '?'}`).join('\n') }
  db.prepare(`UPDATE missions SET status = 'done', result = ?, completed_at = unixepoch() WHERE id = ?`).run(report.slice(0, 50_000), missionId)
  try { const { emitOrionEvent } = await import('../api/orion-stream.js'); emitOrionEvent('mission_result', { goal, status: 'completed', summary: report.slice(0, 800), ts: Date.now() }) } catch {}
  await notifyWhatsApp(goal, report)
}

async function monitorMission(missionId, boardId, boardName, goal) {
  const db = getDb()
  const start = Date.now()
  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS))
    cascadeFailures(boardId)
    const recovered = recoverStaleTasks(90)
    if (recovered > 0) dispatch(boardName, 3).catch(() => {})
    const status = getBoardStatus(boardId)
    const total = Object.values(status).reduce((a, b) => a + b, 0)
    const done = (status.done ?? 0) + (status.failed ?? 0)
    const pending = status.pending ?? 0
    const inProgress = status.in_progress ?? 0
    if (pending > 0 && inProgress === 0) dispatch(boardName, 3).catch(() => {})
    if (total > 0 && done >= total) { await finalizeMission(missionId, boardId, goal); return }
  }
  logger.warn({ missionId }, 'missão atingiu timeout de 30min')
  getDb().prepare(`UPDATE missions SET status = 'failed', completed_at = unixepoch() WHERE id = ?`).run(missionId)
  await notifyWhatsApp(goal, null, true)
}

export function resumeRunningMissions() {
  const missions = getDb().prepare(`SELECT id, goal, board_name, board_id FROM missions WHERE status = 'running'`).all()
  if (!missions.length) return
  for (const m of missions) {
    if (!m.board_name || !m.board_id) continue
    recoverStaleTasks(30)
    dispatch(m.board_name, 3).catch(() => {})
    setImmediate(() => monitorMission(m.id, m.board_id, m.board_name, m.goal).catch(() => getDb().prepare(`UPDATE missions SET status = 'failed', completed_at = unixepoch() WHERE id = ?`).run(m.id)))
  }
}

export function getMission(id) { return getDb().prepare('SELECT * FROM missions WHERE id = ?').get(id) }
export function listMissions(limit = 20) {
  return getDb().prepare('SELECT id, goal, status, source, created_at, started_at, completed_at FROM missions ORDER BY created_at DESC LIMIT ?').all(limit)
}

export async function createAndExecuteMission(goal, { source = 'api', sessionId = null } = {}) {
  const db = getDb()
  logger.info({ goal }, 'planejando missão')
  const plan = await planMission(goal)
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO missions (id, goal, status, plan, source, session_id) VALUES (?, ?, 'planning', ?, ?, ?)`).run(id, goal, JSON.stringify(plan), source, sessionId)
  const boardName = `mission-${id.slice(0, 8)}`
  const board = createBoard(boardName)
  db.prepare(`UPDATE missions SET status = 'running', board_name = ?, board_id = ?, started_at = unixepoch() WHERE id = ?`).run(boardName, board.id, id)
  const taskIds = []
  for (const spec of plan) {
    const depIds = (spec.dependsOn ?? []).map(i => taskIds[i]).filter(Boolean)
    taskIds.push(addTask(board.id, { title: spec.title, description: spec.description, dependsOn: depIds, priority: 0 }))
  }
  dispatch(boardName, 3).catch(() => {})
  setImmediate(() => monitorMission(id, board.id, boardName, goal).catch(() => db.prepare(`UPDATE missions SET status = 'failed', completed_at = unixepoch() WHERE id = ?`).run(id)))
  return { id, plan, boardName, tasks: taskIds.length }
}
