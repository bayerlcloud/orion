/**
 * ACP Server — OpenAI-compatible chat API para integração com VS Code / JetBrains.
 * Exposição: POST /v1/chat/completions (streaming + não-streaming)
 *             GET  /v1/models
 *
 * Compatível com: Continue.dev, VS Code AI Toolkit, JetBrains AI Assistant,
 * Cursor, Zed e qualquer cliente que suporte a API OpenAI.
 *
 * Internamente encaminha para o agente Orion via execa('claude' CLI).
 */
import { execa } from 'execa'
import { createLogger } from '../logger.js'

const logger = createLogger('acp')

const AVAILABLE_MODELS = [
  { id: 'orion', object: 'model', created: 1700000000, owned_by: 'orion', display_name: 'Orion Agent' },
  { id: 'orion-sonnet', object: 'model', created: 1700000000, owned_by: 'orion', display_name: 'Orion (Sonnet)' },
  { id: 'orion-haiku', object: 'model', created: 1700000000, owned_by: 'orion', display_name: 'Orion (Haiku)' },
]

function modelToClaude(modelId) {
  if (modelId?.includes('haiku')) return 'claude-haiku-4-5-20251001'
  return process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
}

function messagestoPrompt(messages) {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n\n') + '\n\nAssistant:'
}

export async function handleChatCompletion(req, res) {
  const { model, messages, stream = false, temperature } = req.body
  if (!messages?.length) return res.status(400).json({ error: { message: 'messages obrigatório' } })

  const claudeModel = modelToClaude(model)
  const prompt = messagestoPrompt(messages)
  const systemMsg = messages.find(m => m.role === 'system')?.content ?? ''
  const completionId = `chatcmpl-orion-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)

  const claudeArgs = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', claudeModel,
  ]
  if (systemMsg) claudeArgs.push('--system', systemMsg)

  logger.info({ model: claudeModel, msgs: messages.length, stream }, 'acp chat request')

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')

    let result
    try {
      result = await execa('claude', claudeArgs, { cwd: '/config/workspace', timeout: 120_000 })
    } catch (err) {
      const errChunk = {
        id: completionId, object: 'chat.completion.chunk', created, model: claudeModel,
        choices: [{ index: 0, delta: { content: `Erro: ${err.message}` }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    let content = ''
    try {
      const parsed = JSON.parse(result.stdout)
      content = parsed.result ?? parsed.content ?? result.stdout
    } catch { content = result.stdout }

    // Simula streaming enviando em chunks de 20 chars
    const words = content.split(' ')
    for (let i = 0; i < words.length; i++) {
      const delta = (i === 0 ? '' : ' ') + words[i]
      const chunk = {
        id: completionId, object: 'chat.completion.chunk', created, model: claudeModel,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    const doneChunk = {
      id: completionId, object: 'chat.completion.chunk', created, model: claudeModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  // Não-streaming
  let result
  try {
    result = await execa('claude', claudeArgs, { cwd: '/config/workspace', timeout: 120_000 })
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } })
  }

  let content = ''
  try {
    const parsed = JSON.parse(result.stdout)
    content = parsed.result ?? parsed.content ?? result.stdout
  } catch { content = result.stdout }

  res.json({
    id: completionId,
    object: 'chat.completion',
    created,
    model: claudeModel,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: Math.round(prompt.length / 4),
      completion_tokens: Math.round(content.length / 4),
      total_tokens: Math.round((prompt.length + content.length) / 4),
    },
  })
}

export function handleListModels(req, res) {
  res.json({ object: 'list', data: AVAILABLE_MODELS })
}

export function handleGetModel(req, res) {
  const m = AVAILABLE_MODELS.find(x => x.id === req.params.id)
  if (!m) return res.status(404).json({ error: { message: 'Model not found' } })
  res.json(m)
}
