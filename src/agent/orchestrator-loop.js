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
const STEP_TIMEOUT_MS = 8 * 60 * 1000   // 8 min por step (delegates podem ser lentos)
const TOTAL_TIMEOUT_MS = 60 * 60 * 1000 // 60 min total

// ── SSE subscribers ───────────────────────────────────────────────────────────
const _subs = new Map() // id → Set<res>

export function subscribeOrch(id, res) {
  if (!_subs.has(id)) _subs.set(id, new Set())
  _subs.get(id).add(res)
}
export function unsubscribeOrch(id, res) {
  _subs.get(id)?.delete(res)
}
function emit(id, event, data) {
  const subs = _subs.get(id)
  if (!subs?.size) return
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of subs) { try { res.write(msg) } catch {} }
}

// ── System prompt do orquestrador (meta-raciocínio) ───────────────────────────
function buildSystemPrompt(goal, workDir) {
  return `Você é um orquestrador autônomo altamente capaz. Seu objetivo é completar:

<GOAL>${goal}</GOAL>

Diretório de trabalho (salve arquivos aqui): ${workDir}

A cada turno recebe o histórico completo e decide o próximo passo.

Responda APENAS com JSON válido neste formato:

Para executar uma ferramenta:
{"reasoning":"por que faço isso agora","action":"use_tool","tool":"nome","input":{...},"progress":"resumo 1 linha do progresso geral"}

Para encerrar com sucesso:
{"reasoning":"...","action":"done","summary":"relatório final detalhado","progress":"100% concluído"}

Para encerrar com falha:
{"reasoning":"...","action":"failed","reason":"motivo claro","progress":"..."}

## Ferramentas disponíveis

delegate — delega qualquer ação concreta a um agente Claude com acesso TOTAL aos MCPs:
  • Bash (shell, npm, python, git, etc.)
  • Read / Write / Edit (arquivos no sistema)
  • WebFetch (baixar qualquer URL, mesmo com JS)
  • WebSearch (busca real na web)
  • Playwright MCP (navegador completo: navegar, clicar, preencher forms, screenshot)
  • ssh-contabo MCP (SSH direto no servidor Contabo — docker, pm2, logs, etc.)
  • hostinger MCP (DNS: criar/editar registros A, CNAME, TXT)
  • github MCP (repos, issues, PRs, push de arquivos)
  • n8n MCP (criar e executar workflows de automação)
  • google MCP (Gmail, Google Drive, Calendar)
  input: {"goal": "descrição DETALHADA do que o agente deve fazer e o que deve retornar"}
  IMPORTANTE: seja específico — inclua URLs, credenciais necessárias, formato de retorno esperado.

parallel — dispara N agentes AO MESMO TEMPO e aguarda todos (ideal para pesquisas em múltiplas fontes, análises independentes, coleta de dados em paralelo)
  input: {"tasks": ["faça X e retorne...", "faça Y e retorne...", "faça Z e retorne..."]}
  Cada task tem acesso total aos MCPs. Máximo 8 tasks por chamada.
  Use quando as tarefas são INDEPENDENTES entre si — se uma depende do resultado da outra, use delegate sequencial.

write_file — salva um arquivo no diretório de trabalho (rápido, sem LLM)
  input: {"path": "nome.ext", "content": "conteúdo completo"}

read_file — lê um arquivo do diretório de trabalho
  input: {"path": "nome.ext"}

list_files — lista arquivos criados no diretório de trabalho
  input: {}

run_shell — executa comando bash direto (para operações simples e rápidas)
  input: {"command": "npm install && node index.js"}

think — raciocinar sem ação (útil para planejamento intermediário)
  input: {"reasoning": "meu raciocínio detalhado"}

ask_approval — PAUSA e pede aprovação do Danilo antes de ação sensível/irreversível
  (deletar dados, gastar dinheiro, enviar mensagem a terceiros, deploy em produção, mexer em DNS).
  A pergunta aparece no chat web E no WhatsApp; a resposta dele destrava você.
  input: {"question": "Posso deletar os 500 registros duplicados?", "context": "resumo do que será feito"}
  Se REJEITADO ou TIMEOUT: não execute a ação — ajuste o plano ou encerre explicando.

## Quando usar cada ferramenta

Use DELEGATE para qualquer coisa que envolva:
- Buscar informações na web (sites, documentação, concorrentes)
- Controlar um navegador (login, scraping, formulários)
- Acessar o servidor (docker ps, pm2 logs, editar configs)
- Interagir com GitHub, DNS, Gmail, Drive
- Escrever código complexo (múltiplos arquivos, lógica elaborada)
- Qualquer tarefa que leve mais de 1 passo

Use RUN_SHELL apenas para comandos simples e rápidos (ls, cat, grep, node script.js).
Use WRITE_FILE / READ_FILE para persistir e consultar artefatos do trabalho.
Use THINK para planejar antes de agir ou avaliar resultados complexos.

## Regras de ouro
1. Seja sistemático: pesquisa → plano → execução → validação
2. Leia o resultado do delegate antes de avançar — não assuma sucesso
3. Se algo falhou, peça ao delegate uma abordagem diferente
4. Salve artefatos intermediários com write_file (planos, resultados parciais)
5. Nunca declare done sem ter VERIFICADO que o objetivo foi atingido
6. Máximo ${MAX_STEPS} passos — seja eficiente, não repita trabalho já feito`
}

// ── System prompt do delegate (agente executor com MCPs) ──────────────────────
// Injeta skills aprendidas pelo Orion relevantes ao goal (o que ele aprendeu
// nas missões passa a ser usado NAS missões)
function relevantSkillsBlock(goal) {
  try {
    const hits = suggestSkillsForMessage(goal, 2)
    if (!hits.length) return ''
    const db = getDb()
    const blocks = hits.map(h => {
      const row = db.prepare(`SELECT name, content FROM skills WHERE name = ? AND status = 'active'`).get(h.name)
      if (!row?.content) return null
      return `### Skill aprendida: ${row.name}\n${String(row.content).slice(0, 1500)}`
    }).filter(Boolean)
    if (!blocks.length) return ''
    return `\n\n## Skills do Orion relevantes a esta tarefa (aplique se fizer sentido)\n${blocks.join('\n\n')}\n`
  } catch { return '' }
}

function buildDelegatePrompt(goal, workDir) {
  return `Você é um agente executor. Complete a seguinte tarefa e retorne o resultado de forma clara e completa:

${goal}${relevantSkillsBlock(goal)}

Diretório de trabalho disponível: ${workDir}

Você tem acesso TOTAL às ferramentas do Claude Code:
- Bash, Read, Write, Edit (sistema de arquivos e shell)
- WebFetch, WebSearch (web)
- Playwright MCP (navegador completo)
- ssh-contabo MCP (SSH no servidor Contabo)
- hostinger MCP (DNS bayerl.cloud)
- github MCP (repositórios)
- n8n MCP (workflows)
- google MCP (Gmail, Drive, Calendar)

Use as ferramentas que precisar para completar a tarefa.
Retorne o resultado de forma estruturada e completa — este resultado será usado pelo orquestrador para decidir o próximo passo.`
}

// ── Ferramentas ───────────────────────────────────────────────────────────────
async function executeTool(tool, input, workDir, orchId) {
  emit(orchId, 'tool_start', { tool, input: JSON.stringify(input).slice(0, 300) })

  try {
    let result

    switch (tool) {
      case 'delegate': {
        const delegateGoal = String(input.goal || '')
        if (!delegateGoal) { result = 'ERRO: goal obrigatório no delegate'; break }

        const systemPrompt = buildDelegatePrompt(delegateGoal, workDir)
        const r = await execa('claude', [
          '-p', delegateGoal,
          '--append-system-prompt', systemPrompt,
          '--output-format', 'json',
          '--dangerously-skip-permissions',
        ], { cwd: workDir, timeout: STEP_TIMEOUT_MS })

        const parsed = JSON.parse(r.stdout)
        result = (parsed.result ?? parsed.content ?? r.stdout).slice(0, 20000)
        break
      }

      case 'parallel': {
        const tasks = Array.isArray(input.tasks) ? input.tasks : []
        if (!tasks.length) { result = 'ERRO: tasks[] obrigatório no parallel'; break }

        emit(orchId, 'parallel_start', { count: tasks.length, tasks: tasks.map((t, i) => ({ i, label: String(t).slice(0, 80) })) })

        const results = await Promise.all(tasks.map(async (taskGoal, i) => {
          try {
            const sp = buildDelegatePrompt(String(taskGoal), workDir)
            const r = await execa('claude', [
              '-p', String(taskGoal),
              '--append-system-prompt', sp,
              '--output-format', 'json',
              '--dangerously-skip-permissions',
            ], { cwd: workDir, timeout: STEP_TIMEOUT_MS })
            const p = JSON.parse(r.stdout)
            const out = (p.result ?? p.content ?? r.stdout).slice(0, 8000)
            emit(orchId, 'parallel_done', { i, label: String(taskGoal).slice(0, 80), preview: out.slice(0, 200) })
            return `### Worker ${i + 1}: ${String(taskGoal).slice(0, 60)}\n${out}`
          } catch (err) {
            emit(orchId, 'parallel_error', { i, error: err.message })
            return `### Worker ${i + 1}: ERRO\n${err.message}`
          }
        }))

        result = results.join('\n\n---\n\n')
        break
      }

      case 'write_file': {
        const safePath = input.path.replace(/\.\./g, '').replace(/^\//, '')
        const fullPath = join(workDir, safePath)
        writeFileSync(fullPath, input.content, 'utf8')
        result = `✓ Arquivo salvo: ${safePath} (${input.content.length} chars)`
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
        const files = readdirSync(workDir)
        result = files.length ? files.join('\n') : '(sem arquivos)'
        break
      }

      case 'run_shell': {
        try {
          const r = await execa('bash', ['-c', input.command], {
            cwd: workDir, timeout: 60000, all: true,
          })
          result = (r.all || r.stdout || '(sem output)').slice(0, 6000)
        } catch (err) {
          result = `ERRO (exit ${err.exitCode ?? '?'}): ${(err.all || err.stderr || err.message).slice(0, 3000)}`
        }
        break
      }

      case 'think': {
        result = `[raciocínio registrado] ${input.reasoning}`
        break
      }

      case 'ask_approval': {
        // Pausa a missão até o Danilo aprovar (web ou WhatsApp). Timeout 15min.
        const { createApproval, waitForApproval } = await import('../api/approvals.js')
        const approvalId = createApproval(input.question || 'Posso prosseguir?', {
          context: input.context || `Missão em andamento (${orchId})`,
          source: 'orchestrator',
        })
        emit(orchId, 'waiting_approval', { question: input.question })
        const status = await waitForApproval(approvalId)
        result = status === 'approved'
          ? 'APROVADO pelo usuário — prossiga.'
          : status === 'rejected'
            ? 'REJEITADO pelo usuário — NÃO execute esta ação. Ajuste o plano ou encerre.'
            : 'TIMEOUT — usuário não respondeu em 15min. NÃO execute a ação; encerre relatando o bloqueio.'
        break
      }

      default:
        result = `ERRO: ferramenta desconhecida "${tool}". Use: delegate, write_file, read_file, list_files, run_shell, think, ask_approval`
    }

    emit(orchId, 'tool_result', { tool, preview: String(result).slice(0, 400) })
    return { ok: true, result: String(result) }

  } catch (err) {
    const error = `ERRO ao executar ${tool}: ${err.message}`
    emit(orchId, 'tool_error', { tool, error })
    return { ok: false, result: error }
  }
}

// ── Loop principal ────────────────────────────────────────────────────────────
async function runLoop(orchId, goal, workDir) {
  const db = getDb()
  const steps = []
  const start = Date.now()

  emit(orchId, 'started', { goal })
  emitOrionEvent('system_event', { text: `⚡ Missão iniciada: ${goal.slice(0, 80)}`, ts: Date.now() })
  logger.info({ orchId, goal }, 'loop iniciado')

  for (let i = 0; i < MAX_STEPS; i++) {
    if (Date.now() - start > TOTAL_TIMEOUT_MS) {
      const msg = 'Timeout de 60 min atingido'
      db.prepare(`UPDATE orchestrations SET status='failed', error=?, steps=?, completed_at=unixepoch() WHERE id=?`)
        .run(msg, JSON.stringify(steps), orchId)
      emit(orchId, 'failed', { error: msg })
      return
    }

    // Contexto comprimido — últimos 12 passos completos, anteriores resumidos
    const recentSteps = steps.slice(-12)
    const olderCount = steps.length - recentSteps.length
    const historyText = steps.length === 0
      ? 'Nenhum passo executado ainda. Primeiro passo — comece planejando.'
      : (olderCount > 0 ? `[... ${olderCount} passos anteriores comprimidos ...]\n\n` : '')
        + recentSteps.map((s, idx) =>
          `### Passo ${steps.length - recentSteps.length + idx + 1}: ${s.tool}\n` +
          `Raciocínio: ${s.reasoning}\n` +
          `Input: ${JSON.stringify(s.input).slice(0, 400)}\n` +
          `Resultado: ${String(s.result).slice(0, 2000)}\n`
        ).join('\n---\n')

    const prompt = buildSystemPrompt(goal, workDir) +
      `\n\n## Histórico (${steps.length} passos executados):\n${historyText}\n\n` +
      `## Decisão para o Passo ${i + 1} (responda APENAS JSON válido):`

    emit(orchId, 'thinking', { step: i + 1, progress: steps[steps.length - 1]?.progress || 'iniciando...' })

    let decision
    try {
      const r = await execa('claude', [
        '-p', prompt,
        '--output-format', 'json',
        '--model', SONNET,
        '--dangerously-skip-permissions',
      ], { cwd: workDir, timeout: 90_000 })

      const outer = JSON.parse(r.stdout)
      const raw = (outer.result ?? outer.content ?? r.stdout).trim()
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('sem JSON na resposta')
      decision = JSON.parse(match[0])
    } catch (err) {
      logger.warn({ err, orchId, step: i }, 'erro ao parsear decisão')
      steps.push({ num: i + 1, action: 'error', tool: 'parse_error', reasoning: 'Falha ao parsear resposta', input: {}, result: err.message, ok: false, at: Date.now() })
      db.prepare(`UPDATE orchestrations SET steps=? WHERE id=?`).run(JSON.stringify(steps), orchId)
      emit(orchId, 'step', { num: i + 1, tool: 'error', reasoning: 'Falha ao parsear resposta', progress: '...' })
      continue
    }

    emit(orchId, 'decision', {
      step: i + 1,
      action: decision.action,
      tool: decision.tool,
      reasoning: decision.reasoning,
      progress: decision.progress,
    })

    if (decision.action === 'done') {
      const result = decision.summary || 'Objetivo concluído'
      db.prepare(`UPDATE orchestrations SET status='done', result=?, steps=?, completed_at=unixepoch() WHERE id=?`)
        .run(result, JSON.stringify(steps), orchId)
      emit(orchId, 'done', { result, steps_count: steps.length, elapsed_ms: Date.now() - start })
      emitOrionEvent('mission_result', {
        goal, status: 'completed', summary: result.slice(0, 800),
        elapsed: `${Math.round((Date.now() - start) / 60000)}min · ${steps.length} passos`, ts: Date.now(),
      })
      logger.info({ orchId, steps: steps.length }, 'orquestração concluída')
      return
    }

    if (decision.action === 'failed') {
      const reason = decision.reason || 'Falha não especificada'
      db.prepare(`UPDATE orchestrations SET status='failed', error=?, steps=?, completed_at=unixepoch() WHERE id=?`)
        .run(reason, JSON.stringify(steps), orchId)
      emit(orchId, 'failed', { error: reason })
      emitOrionEvent('mission_result', {
        goal, status: 'failed', summary: reason.slice(0, 500),
        elapsed: `${Math.round((Date.now() - start) / 60000)}min`, ts: Date.now(),
      })
      logger.warn({ orchId, reason }, 'orquestração falhou')
      return
    }

    const { ok, result } = await executeTool(decision.tool, decision.input ?? {}, workDir, orchId)

    const step = {
      num: i + 1,
      action: decision.action,
      tool: decision.tool || 'unknown',
      input: decision.input || {},
      reasoning: decision.reasoning || '',
      progress: decision.progress || '',
      result,
      ok,
      at: Date.now(),
    }
    steps.push(step)
    db.prepare(`UPDATE orchestrations SET steps=? WHERE id=?`).run(JSON.stringify(steps), orchId)
    emit(orchId, 'step', { num: i + 1, tool: step.tool, reasoning: step.reasoning, progress: step.progress, ok, result_preview: result.slice(0, 300) })
  }

  const lastProgress = steps[steps.length - 1]?.progress || 'limite atingido'
  db.prepare(`UPDATE orchestrations SET status='failed', error=?, steps=?, completed_at=unixepoch() WHERE id=?`)
    .run(`Limite de ${MAX_STEPS} passos. ${lastProgress}`, JSON.stringify(steps), orchId)
  emit(orchId, 'failed', { error: `Limite de ${MAX_STEPS} passos atingido` })
}

// ── API pública ───────────────────────────────────────────────────────────────
export async function createOrchestration(goal, { source = 'api' } = {}) {
  const db = getDb()
  const id = crypto.randomUUID()
  const workDir = `/config/workspace/orion/data/orchestrations/${id}`
  mkdirSync(workDir, { recursive: true })

  db.prepare(`INSERT INTO orchestrations (id, goal, status, work_dir, source) VALUES (?, ?, 'running', ?, ?)`)
    .run(id, goal, workDir, source)

  logger.info({ id, goal }, 'orquestração criada')

  setImmediate(() => {
    runLoop(id, goal, workDir).catch(err => {
      logger.error({ err, id }, 'loop crashed')
      getDb().prepare(`UPDATE orchestrations SET status='failed', error=?, completed_at=unixepoch() WHERE id=?`)
        .run(err.message, id)
      emit(id, 'failed', { error: err.message })
    })
  })

  return { id, workDir }
}

export function getOrchestration(id) {
  const row = getDb().prepare('SELECT * FROM orchestrations WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, steps: JSON.parse(row.steps ?? '[]') }
}

export function listOrchestrations(limit = 20) {
  return getDb().prepare(
    'SELECT id, goal, status, source, work_dir, created_at, completed_at FROM orchestrations ORDER BY created_at DESC LIMIT ?'
  ).all(limit)
}

export function resumeRunningOrchestrations() {
  const running = getDb().prepare(`SELECT id, goal, work_dir FROM orchestrations WHERE status = 'running'`).all()
  if (!running.length) return
  logger.info({ count: running.length }, 'retomando orquestrações após restart')
  for (const o of running) {
    if (!o.work_dir) continue
    setImmediate(() => {
      runLoop(o.id, o.goal, o.work_dir).catch(err => {
        getDb().prepare(`UPDATE orchestrations SET status='failed', error=?, completed_at=unixepoch() WHERE id=?`).run(err.message, o.id)
      })
    })
  }
}
