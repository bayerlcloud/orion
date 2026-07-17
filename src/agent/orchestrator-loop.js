import { execa } from 'execa'
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
import { emitOrionEvent } from '../api/orion-stream.js'
import { suggestSkillsForMessage } from './skill-recommender.js'

const logger = createLogger('orch-loop')
const SONNET = 'claude-sonnet-4-6'
const MAX_STEPS = 25
const STEP_TIMEOUT_MS = 8 * 60 * 1000
const TOTAL_TIMEOUT_MS = 60 * 60 * 1000

const _subs = new Map()
export function subscribeOrch(id, res) { if (!_subs.has(id)) _subs.set(id, new Set()); _subs.get(id).add(res) }
export function unsubscribeOrch(id, res) { _subs.get(id)?.delete(res) }
function emit(id, event, data) {
  const subs = _subs.get(id); if (!subs?.size) return
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of subs) { try { res.write(msg) } catch {} }
}

function relevantSkillsBlock(goal) {
  try {
    const hits = suggestSkillsForMessage(goal, 2)
    if (!hits.length) return ''
    const db = getDb()
    const blocks = hits.map(h => {
      const row = db.prepare(`SELECT name, content FROM skills WHERE name = ? AND status = 'active'`).get(h.name)
      if (!row?.content) return null
      return `### Skill: ${row.name}\n${String(row.content).slice(0, 1500)}`
    }).filter(Boolean)
    return blocks.length ? `\n\n## Skills relevantes\n${blocks.join('\n\n')}\n` : ''
  } catch { return '' }
}

function buildSystemPrompt(goal, workDir) {
  return `Você é um orquestrador autônomo.\n\n<GOAL>${goal}</GOAL>\n\nDiretório de trabalho: ${workDir}\n\nA cada turno decide o próximo passo. Responda APENAS com JSON válido:\n\n{"reasoning":"...","action":"use_tool","tool":"nome","input":{...},"progress":"..."} — para executar\n{"reasoning":"...","action":"done","summary":"...","progress":"100%"} — para encerrar\n{"reasoning":"...","action":"failed","reason":"...","progress":"..."} — para falha\n\nFerramentas: delegate, parallel, write_file, read_file, list_files, run_shell, think, ask_approval.\nMáximo ${MAX_STEPS} passos.`
}

function buildDelegatePrompt(goal, workDir) {
  return `Você é um agente executor. Complete esta tarefa e retorne o resultado completo:\n\n${goal}${relevantSkillsBlock(goal)}\n\nDiretório de trabalho: ${workDir}\nVocê tem acesso total às ferramentas do Claude Code (Bash, Read, Write, Edit, WebFetch, WebSearch, MCP tools).`
}

async function executeTool(tool, input, workDir, orchId) {
  emit(orchId, 'tool_start', { tool, input: JSON.stringify(input).slice(0, 300) })
  try {
    let result
    switch (tool) {
      case 'delegate': {
        const delegateGoal = String(input.goal || '')
        if (!delegateGoal) { result = 'ERRO: goal obrigatório'; break }
        const r = await execa('claude', ['-p', delegateGoal, '--append-system-prompt', buildDelegatePrompt(delegateGoal, workDir), '--output-format', 'json', '--dangerously-skip-permissions'], { cwd: workDir, timeout: STEP_TIMEOUT_MS })
        const parsed = JSON.parse(r.stdout)
        result = (parsed.result ?? parsed.content ?? r.stdout).slice(0, 20000)
        break
      }
      case 'parallel': {
        const tasks = Array.isArray(input.tasks) ? input.tasks : []
        if (!tasks.length) { result = 'ERRO: tasks[] obrigatório'; break }
        emit(orchId, 'parallel_start', { count: tasks.length })
        const results = await Promise.all(tasks.map(async (taskGoal, i) => {
          try {
            const r = await execa('claude', ['-p', String(taskGoal), '--append-system-prompt', buildDelegatePrompt(String(taskGoal), workDir), '--output-format', 'json', '--dangerously-skip-permissions'], { cwd: workDir, timeout: STEP_TIMEOUT_MS })
            const p = JSON.parse(r.stdout)
            const out = (p.result ?? p.content ?? r.stdout).slice(0, 8000)
            emit(orchId, 'parallel_done', { i })
            return `### Worker ${i + 1}\n${out}`
          } catch (err) { emit(orchId, 'parallel_error', { i, error: err.message }); return `### Worker ${i + 1}: ERRO\n${err.message}` }
        }))
        result = results.join('\n\n---\n\n')
        break
      }
      case 'write_file': {
        const safePath = input.path.replace(/\.\./g, '').replace(/^\//, '')
        writeFileSync(join(workDir, safePath), input.content, 'utf8')
        result = `✓ Arquivo salvo: ${safePath}`
        break
      }
      case 'read_file': {
        const safePath = input.path.replace(/\.\./g, '').replace(/^\//, '')
        const fullPath = join(workDir, safePath)
        if (!existsSync(fullPath)) { result = `ERRO: arquivo não encontrado: ${safePath}`; break }
        result = readFileSync(fullPath, 'utf8').slice(0, 15000)
        break
      }
      case 'list_files': {
        if (!existsSync(workDir)) { result = '(diretório vazio)'; break }
        result = readdirSync(workDir).join('\n') || '(sem arquivos)'
        break
      }
      case 'run_shell': {
        try {
          const r = await execa('bash', ['-c', input.command], { cwd: workDir, timeout: 60000, all: true })
          result = (r.all || r.stdout || '(sem output)').slice(0, 6000)
        } catch (err) { result = `ERRO (exit ${err.exitCode ?? '?'}): ${(err.all || err.stderr || err.message).slice(0, 3000)}` }
        break
      }
      case 'think': {
        result = `[raciocínio] ${input.reasoning}`
        break
      }
      case 'ask_approval': {
        const { createApproval, waitForApproval } = await import('../api/approvals.js')
        const approvalId = createApproval(input.question || 'Posso prosseguir?', { context: input.context || `Missão (${orchId})`, source: 'orchestrator' })
        emit(orchId, 'waiting_approval', { question: input.question })
        const status = await waitForApproval(approvalId)
        result = status === 'approved' ? 'APROVADO' : status === 'rejected' ? 'REJEITADO — não execute esta ação.' : 'TIMEOUT — não execute a ação.'
        break
      }
      default: result = `ERRO: ferramenta desconhecida "${tool}"`
    }
    emit(orchId, 'tool_result', { tool, preview: String(result).slice(0, 400) })
    return { ok: true, result: String(result) }
  } catch (err) {
    const error = `ERRO ao executar ${tool}: ${err.message}`
    emit(orchId, 'tool_error', { tool, error })
    return { ok: false, result: error }
  }
}

async function runLoop(orchId, goal, workDir) {
  const db = getDb(); const steps = []; const start = Date.now()
  emit(orchId, 'started', { goal })
  emitOrionEvent('system_event', { text: `⚡ Missão iniciada: ${goal.slice(0, 80)}`, ts: Date.now() })
  logger.info({ orchId, goal }, 'loop iniciado')

  for (let i = 0; i < MAX_STEPS; i++) {
    if (Date.now() - start > TOTAL_TIMEOUT_MS) {
      db.prepare(`UPDATE orchestrations SET status='failed', error=?, steps=?, completed_at=unixepoch() WHERE id=?`).run('Timeout de 60 min', JSON.stringify(steps), orchId)
      emit(orchId, 'failed', { error: 'Timeout' }); return
    }
    const recentSteps = steps.slice(-12)
    const olderCount = steps.length - recentSteps.length
    const historyText = steps.length === 0 ? 'Primeiro passo.' :
      (olderCount > 0 ? `[... ${olderCount} passos anteriores ...]\n\n` : '') +
      recentSteps.map((s, idx) => `### Passo ${steps.length - recentSteps.length + idx + 1}: ${s.tool}\nRaciocínio: ${s.reasoning}\nInput: ${JSON.stringify(s.input).slice(0, 400)}\nResultado: ${String(s.result).slice(0, 2000)}`).join('\n---\n')
    const prompt = buildSystemPrompt(goal, workDir) + `\n\n## Histórico (${steps.length} passos):\n${historyText}\n\n## Decisão para o Passo ${i + 1}:`
    emit(orchId, 'thinking', { step: i + 1 })
    let decision
    try {
      const r = await execa('claude', ['-p', prompt, '--output-format', 'json', '--model', SONNET, '--dangerously-skip-permissions'], { cwd: workDir, timeout: 90_000 })
      const outer = JSON.parse(r.stdout)
      const raw = (outer.result ?? outer.content ?? r.stdout).trim()
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('sem JSON')
      decision = JSON.parse(match[0])
    } catch (err) {
      logger.warn({ err, orchId, step: i }, 'erro ao parsear decisão')
      steps.push({ num: i + 1, tool: 'parse_error', reasoning: 'Falha', input: {}, result: err.message, ok: false, at: Date.now() })
      continue
    }
    emit(orchId, 'decision', { step: i + 1, action: decision.action, tool: decision.tool, reasoning: decision.reasoning })
    if (decision.action === 'done') {
      const result = decision.summary || 'Objetivo concluído'
      db.prepare(`UPDATE orchestrations SET status='done', result=?, steps=?, completed_at=unixepoch() WHERE id=?`).run(result, JSON.stringify(steps), orchId)
      emit(orchId, 'done', { result, steps_count: steps.length })
      emitOrionEvent('mission_result', { goal, status: 'completed', summary: result.slice(0, 800), ts: Date.now() })
      logger.info({ orchId, steps: steps.length }, 'orquestração concluída'); return
    }
    if (decision.action === 'failed') {
      const reason = decision.reason || 'Falha'
      db.prepare(`UPDATE orchestrations SET status='failed', error=?, steps=?, completed_at=unixepoch() WHERE id=?`).run(reason, JSON.stringify(steps), orchId)
      emit(orchId, 'failed', { error: reason }); return
    }
    const { ok, result } = await executeTool(decision.tool, decision.input ?? {}, workDir, orchId)
    const step = { num: i + 1, action: decision.action, tool: decision.tool || 'unknown', input: decision.input || {}, reasoning: decision.reasoning || '', progress: decision.progress || '', result, ok, at: Date.now() }
    steps.push(step)
    db.prepare(`UPDATE orchestrations SET steps=? WHERE id=?`).run(JSON.stringify(steps), orchId)
    emit(orchId, 'step', { num: i + 1, tool: step.tool, reasoning: step.reasoning, ok, result_preview: result.slice(0, 300) })
  }
  db.prepare(`UPDATE orchestrations SET status='failed', error=?, steps=?, completed_at=unixepoch() WHERE id=?`).run(`Limite de ${MAX_STEPS} passos`, JSON.stringify(steps), orchId)
  emit(orchId, 'failed', { error: `Limite de ${MAX_STEPS} passos` })
}

export async function createOrchestration(goal, { source = 'api' } = {}) {
  const db = getDb()
  const id = crypto.randomUUID()
  const workDir = `/config/workspace/orion/data/orchestrations/${id}`
  mkdirSync(workDir, { recursive: true })
  db.prepare(`INSERT INTO orchestrations (id, goal, status, work_dir, source) VALUES (?, ?, 'running', ?, ?)`).run(id, goal, workDir, source)
  logger.info({ id, goal }, 'orquestração criada')
  setImmediate(() => runLoop(id, goal, workDir).catch(err => {
    logger.error({ err, id }, 'loop crashed')
    getDb().prepare(`UPDATE orchestrations SET status='failed', error=?, completed_at=unixepoch() WHERE id=?`).run(err.message, id)
    emit(id, 'failed', { error: err.message })
  }))
  return { id, workDir }
}

export function getOrchestration(id) {
  const row = getDb().prepare('SELECT * FROM orchestrations WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, steps: JSON.parse(row.steps ?? '[]') }
}

export function listOrchestrations(limit = 20) {
  return getDb().prepare('SELECT id, goal, status, source, work_dir, created_at, completed_at FROM orchestrations ORDER BY created_at DESC LIMIT ?').all(limit)
}

export function resumeRunningOrchestrations() {
  const running = getDb().prepare(`SELECT id, goal, work_dir FROM orchestrations WHERE status = 'running'`).all()
  if (!running.length) return
  logger.info({ count: running.length }, 'retomando orquestrações')
  for (const o of running) {
    if (!o.work_dir) continue
    setImmediate(() => runLoop(o.id, o.goal, o.work_dir).catch(err => getDb().prepare(`UPDATE orchestrations SET status='failed', error=?, completed_at=unixepoch() WHERE id=?`).run(err.message, o.id)))
  }
}
