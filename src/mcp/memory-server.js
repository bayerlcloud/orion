#!/usr/bin/env node
/**
 * Orion Memory+Context MCP — servidor stdio para o Claude Code plugin.
 *
 * Ferramentas:
 *   orion_memory_context(message)  — memórias relevantes (BM25 + vetor)
 *   orion_memory_save(content)     — salva memória nova
 *   orion_memory_search(query)     — busca explícita
 *   orion_context(message)         — contexto COMPLETO: user.md + memories + skills + projeto
 *   orion_delegate(goal, role)     — delega tarefa para sessão visível no plugin
 */

import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { retrieveMemories, saveMemory } from '../memory/index.js'
import { buildFullContext } from '../api/context.js'
import { delegate } from '../agent/delegate.js'
import { createAndExecuteMission } from '../agent/mission.js'
import { createOrchestration, getOrchestration } from '../agent/orchestrator-loop.js'

const server = new Server(
  { name: 'orion-memory', version: '3.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'orion_memory_context',
      description: 'Retorna memórias relevantes do Orion para uma mensagem. Use para contexto rápido de memórias.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'A mensagem atual do usuário' },
          limit:   { type: 'number', description: 'Máximo de memórias (default: 8)' },
        },
        required: ['message'],
      },
    },
    {
      name: 'orion_memory_save',
      description: 'Salva uma memória nova no Orion. Chame quando aprender algo importante.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'O fato ou informação a salvar' },
          type:    { type: 'string', enum: ['raw', 'episodic', 'semantic'], description: 'Tipo (default: episodic)' },
        },
        required: ['content'],
      },
    },
    {
      name: 'orion_memory_search',
      description: 'Busca explícita por memórias relacionadas a uma query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'O que buscar' },
          limit: { type: 'number', description: 'Máximo de resultados (default: 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'orion_context',
      description: 'Retorna contexto COMPLETO do Orion: perfil do usuário + memórias + skills + CLAUDE.md do projeto detectado.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string',  description: 'A mensagem ou tarefa atual' },
          project: { type: 'string',  description: 'Slug do projeto (opcional)' },
          limit:   { type: 'number',  description: 'Máximo de memórias a incluir (default: 6)' },
        },
        required: ['message'],
      },
    },
    {
      name: 'orion_mission',
      description: 'Cria uma missão paralela: Haiku decompõe o objetivo em 4-8 subtarefas independentes que rodam em paralelo.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Objetivo da missão' },
        },
        required: ['goal'],
      },
    },
    {
      name: 'orion_orchestrate',
      description: 'Inicia o Agente em Loop: Sonnet pensa → age com ferramentas reais → avalia resultado → repete até concluir.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Objetivo do agente autônomo' },
        },
        required: ['goal'],
      },
    },
    {
      name: 'orion_delegate',
      description: 'Delega uma tarefa para um sub-agente especializado. O worker executa em uma sessão Claude Code visível no sidebar do plugin.',
      inputSchema: {
        type: 'object',
        properties: {
          goal:        { type: 'string', description: 'Descrição clara do que o sub-agente deve fazer' },
          role:        { type: 'string', enum: ['researcher', 'coder', 'analyst', 'writer', 'executor'], description: 'Papel do sub-agente (default: executor)' },
          project:     { type: 'string', description: 'Slug do projeto relacionado (opcional)' },
          sessionName: { type: 'string', description: 'Nome da sessão no sidebar (ex: "Coder: Brandspace Auth"). Gerado automaticamente se omitido.' },
          context:     { type: 'string', description: 'Contexto adicional para o sub-agente (opcional)' },
        },
        required: ['goal'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'orion_memory_context') {
    const query = args?.message ?? ''
    if (!query) return { content: [{ type: 'text', text: 'Nenhuma memória relevante.' }] }
    const memories = retrieveMemories(query, { limit: args?.limit ?? 8 })
    if (!memories.length) return { content: [{ type: 'text', text: 'Nenhuma memória relevante.' }] }
    const lines = memories.map(m => `[${m.type}] ${m.content}`)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  if (name === 'orion_memory_save') {
    const id = saveMemory({
      content:    args.content,
      type:       args.type ?? 'episodic',
      source:     'plugin',
      confidence: 0.7,
      sourceTool: 'mcp-save',
    })
    return { content: [{ type: 'text', text: `Memória salva (id: ${id})` }] }
  }

  if (name === 'orion_memory_search') {
    const results = retrieveMemories(args.query, { limit: args.limit ?? 10 })
    if (!results.length) return { content: [{ type: 'text', text: 'Nenhum resultado.' }] }
    const lines = results.map((m, i) => `${i + 1}. [${m.type}, conf:${m.confidence.toFixed(2)}] ${m.content}`)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  if (name === 'orion_context') {
    const message = args?.message ?? ''
    if (!message) return { content: [{ type: 'text', text: 'Parâmetro message obrigatório.' }] }
    const ctx = await buildFullContext(message, { limit: args?.limit ?? 6, project: args?.project ?? null })
    const parts = []
    if (ctx.projectSlug) parts.push(`📁 Projeto detectado: ${ctx.projectSlug}`)
    if (ctx.projectContext) parts.push(`\n--- CLAUDE.md de ${ctx.projectContext.name} ---\n${ctx.projectContext.content.slice(0, 2000)}`)
    if (ctx.userProfile) parts.push(`\n--- Perfil do usuário ---\n${ctx.userProfile.slice(0, 1000)}`)
    if (ctx.memories?.length) { parts.push(`\n--- Memórias relevantes (${ctx.memories.length}) ---`); parts.push(...ctx.memories.map(m => `[${m.type}] ${m.content}`)) }
    if (ctx.skills?.length) { parts.push(`\n--- Skills relevantes (${ctx.skills.length}) ---`); parts.push(...ctx.skills.map(s => `## ${s.name}: ${s.description}`)) }
    const text = parts.length ? parts.join('\n') : 'Nenhum contexto relevante encontrado.'
    return { content: [{ type: 'text', text }] }
  }

  if (name === 'orion_mission') {
    const { goal } = args
    if (!goal) return { content: [{ type: 'text', text: 'Parâmetro goal obrigatório.' }] }
    const result = await createAndExecuteMission(goal, { source: 'mcp' })
    return { content: [{ type: 'text', text: `🚀 Missão criada!\nID: ${result.id}\nSubtarefas: ${result.tasks}\n\nExecutando em paralelo.` }] }
  }

  if (name === 'orion_orchestrate') {
    const { goal } = args
    if (!goal) return { content: [{ type: 'text', text: 'Parâmetro goal obrigatório.' }] }
    const { id } = await createOrchestration(goal, { source: 'mcp' })
    const baseUrl = process.env.ORION_BASE_URL || 'http://localhost:8088'
    setImmediate(async () => {
      try {
        const { sendWhatsApp } = await import('../gateway/evolution.js')
        const jid = process.env.WHATSAPP_OWNER_JID
        if (!jid) return
        const POLL_MS = 15_000
        const MAX_WAIT = 50 * 60 * 1000
        const start = Date.now()
        while (Date.now() - start < MAX_WAIT) {
          await new Promise(r => setTimeout(r, POLL_MS))
          const o = getOrchestration(id)
          if (!o || o.status === 'running') continue
          if (o.status === 'done') {
            await sendWhatsApp(jid, `✅ *Agente concluído*\n*Objetivo:* ${goal}\n\n${(o.result ?? '').slice(0, 3000)}`).catch(() => {})
          } else {
            await sendWhatsApp(jid, `❌ *Agente falhou*\n*Objetivo:* ${goal}\n${o.error ?? ''}`).catch(() => {})
          }
          return
        }
        await sendWhatsApp(jid, `⏰ *Agente: timeout 50min*\n*Objetivo:* ${goal}`).catch(() => {})
      } catch {}
    })
    return { content: [{ type: 'text', text: `🤖 Agente em loop iniciado!\nID: ${id}\n\nO agente vai pensar, usar ferramentas e iterar até concluir.` }] }
  }

  if (name === 'orion_delegate') {
    const { goal, role = 'executor', project = null, sessionName = null, context = '' } = args
    if (!goal) return { content: [{ type: 'text', text: 'Parâmetro goal obrigatório.' }] }
    const result = await delegate({ goal, role, project, sessionName, context, depth: 0 })
    const text = result.error
      ? `❌ Delegate falhou: ${result.output}`
      : `✅ Sessão "${result.sessionName}" concluída:\n\n${result.output}`
    return { content: [{ type: 'text', text }] }
  }

  throw new Error(`Ferramenta desconhecida: ${name}`)
})

const transport = new StdioServerTransport()
await server.connect(transport)
