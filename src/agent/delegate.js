/**
 * Delegate — spawn de sub-agentes como sessões visíveis no plugin Claude Code.
 *
 * Inspirado no delegate_tool.py do Hermes.
 * Cada worker aparece no sidebar como uma sessão nomeada e pode ser inspecionado.
 *
 * Roles disponíveis:
 *   researcher — lê e busca, sem escrever
 *   coder      — lê e escreve código
 *   analyst    — interpreta dados
 *   writer     — produz texto
 *   executor   — executa tarefas completas (full tools)
 */

import { execa } from 'execa'
import { getOrCreate, updateClaudeSessionId, projectSessionName } from '../sessions/registry.js'
import { buildFullContext, serializeContext } from '../api/context.js'
import { saveMemory } from '../memory/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('delegate')

const ROLE_SYSTEM_PROMPTS = {
  researcher: `Você é um pesquisador. Sua única função é coletar e analisar informações.
- Use ferramentas de leitura e busca
- NÃO modifique arquivos
- Responda com dados concretos e fontes
- Língua: português brasileiro`,

  coder: `Você é um programador experiente.
- Leia arquivos, escreva código, resolva problemas técnicos
- Siga as convenções do projeto (leia CLAUDE.md do projeto se existir)
- Código limpo, sem comentários óbvios
- Língua: português brasileiro`,

  analyst: `Você é um analista de dados e sistemas.
- Interprete padrões, identifique problemas, gere insights acionáveis
- Baseie conclusões em evidências concretas
- Língua: português brasileiro`,

  writer: `Você é um redator técnico.
- Produza texto claro, estruturado e objetivo
- Use markdown quando adequado
- Língua: português brasileiro`,

  executor: `Você é um executor autônomo. Execute a tarefa completamente.
- Leia arquivos, escreva código, rode comandos, configure serviços
- Conclua a tarefa sem pedir confirmação para ações reversíveis
- Reporte o que foi feito ao final
- Língua: português brasileiro`,
}

const ROLE_ALLOWED_TOOLS = {
  researcher: 'Read,Grep,Glob,WebFetch,WebSearch',
  coder:      'Read,Grep,Glob,Edit,Write,Bash',
  analyst:    'Read,Grep,Glob',
  writer:     'Read,Write',
  executor:   '*',  // full tools — executa de verdade
}

const MAX_DEPTH = 2  // delegates não podem criar sub-delegates

// ── Core: executa uma tarefa delegada ────────────────────────────────────────

export async function delegate({
  goal,
  role        = 'executor',
  context     = '',
  project     = null,
  sessionName = null,
  depth       = 0,
}) {
  if (depth >= MAX_DEPTH) {
    log.warn(`[delegate] profundidade máxima atingida para: ${goal.slice(0, 60)}`)
    return { output: '[bloqueado: profundidade máxima de delegação atingida]', sessionName }
  }

  const name = sessionName ?? `Delegate: ${goal.slice(0, 45)}`
  const reg  = getOrCreate(name, { project, role })

  log.info(`[delegate] iniciando "${name}" (role: ${role}, depth: ${depth})`)

  // Montar contexto completo (mesmo pipeline do WhatsApp)
  const fullCtx = await buildFullContext(goal, { project })
  const ctxStr  = serializeContext(fullCtx)

  const systemPrompt  = ROLE_SYSTEM_PROMPTS[role]  ?? ROLE_SYSTEM_PROMPTS.executor
  const allowedTools  = ROLE_ALLOWED_TOOLS[role]   ?? '*'

  const prompt = [goal, context ? `\nContexto adicional:\n${context}` : '', ctxStr].filter(Boolean).join('\n')

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--system-prompt', systemPrompt,
  ]

  if (allowedTools !== '*') {
    args.push('--allowedTools', allowedTools)
  }

  // Retoma sessão existente se disponível
  if (reg.claude_session_id) {
    args.push('--resume', reg.claude_session_id)
  }

  try {
    const result = await execa('claude', args, {
      timeout: 300_000,
      cwd: '/config/workspace',   // workspace principal → aparece no sidebar
    })

    const parsed         = JSON.parse(result.stdout)
    const output         = parsed.result ?? parsed.content ?? ''
    const claudeSessionId = parsed.session_id

    if (claudeSessionId && claudeSessionId !== reg.claude_session_id) {
      updateClaudeSessionId(reg.id, claudeSessionId)
    }

    log.info(`[delegate] "${name}" concluído (${output.length} chars)`)

    // ── B. on_delegation: captura resultado do subagente como memória ────────
    setImmediate(() => {
      try {
        const snippet = output.slice(0, 400).replace(/\s+/g, ' ').trim()
        if (snippet.length > 20) {
          saveMemory({
            content: `Tarefa delegada (${role}): "${goal.slice(0, 120)}" → ${snippet}`,
            type: 'episodic',
            source: 'delegate',
            confidence: 0.6,
            category: 'decision',
            tags: ['delegate', role, ...(project ? [project] : [])],
            sourceTool: 'delegate',
            sourceSessionId: claudeSessionId ?? null,
          })
        }
      } catch {}
    })

    return { output, sessionName: name, claudeSessionId, registryId: reg.id }

  } catch (err) {
    log.error(`[delegate] "${name}" falhou:`, err.message)
    return { output: `Erro: ${err.message}`, sessionName: name, error: true }
  }
}

// ── Orchestrate: planner → workers paralelos → synthesizer ───────────────────

export async function orchestrate(message, { project = null, maxConcurrent = 3 } = {}) {
  log.info(`[orchestrate] iniciando: ${message.slice(0, 80)}`)

  // Fase 1: Planner via Haiku
  const planPrompt = `Divida a tarefa em 2-4 subtarefas independentes que podem ser executadas em paralelo.

Tarefa: ${message}

Responda SOMENTE com JSON válido:
[
  {
    "goal": "descrição clara da subtarefa",
    "role": "researcher|coder|analyst|writer|executor",
    "sessionName": "Nome Descritivo da Sessão"
  }
]

Regras:
- sessionName deve ser descritivo e único (ex: "Coder: Brandspace Auth", "Researcher: DNS Config")
- role deve ser o mais específico possível
- mínimo 2, máximo 4 subtarefas`

  let subtasks = []
  try {
    const planResult = await execa('claude', [
      '-p', planPrompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 30_000 })

    const planParsed = JSON.parse(planResult.stdout)
    const planText   = planParsed.result ?? planParsed.content ?? ''
    subtasks = JSON.parse(planText.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
    if (subtasks.length < 2) throw new Error('plano inválido')
    log.info(`[orchestrate] ${subtasks.length} subtarefas planejadas`)
  } catch (err) {
    log.error('[orchestrate] planner falhou:', err.message)
    return null
  }

  // Fase 2: Workers com concorrência limitada
  const results = []
  for (let i = 0; i < subtasks.length; i += maxConcurrent) {
    const batch = subtasks.slice(i, i + maxConcurrent)
    const batchResults = await Promise.allSettled(
      batch.map(task => delegate({
        goal:        task.goal,
        role:        task.role,
        project,
        sessionName: task.sessionName,
        depth:       1,
      }))
    )
    results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : null))
  }

  const successful = results.filter(r => r && !r.error)
  log.info(`[orchestrate] ${successful.length}/${subtasks.length} workers ok`)
  if (!successful.length) return null

  // Fase 3: Synthesizer
  const blocks = successful
    .map((r, i) => `=== ${i + 1}. ${r.sessionName} ===\n${r.output}`)
    .join('\n\n')

  try {
    const synthResult = await execa('claude', [
      '-p', `Objetivo original: ${message}\n\nResultados dos workers:\n${blocks}\n\nCombine em resposta coesa e objetiva em português.`,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 60_000 })

    const synthParsed = JSON.parse(synthResult.stdout)
    log.info('[orchestrate] síntese concluída')
    return synthParsed.result ?? synthParsed.content ?? ''
  } catch (err) {
    log.error('[orchestrate] synthesizer falhou:', err.message)
    return successful.map(r => `*${r.sessionName}:*\n${r.output}`).join('\n\n---\n\n')
  }
}
