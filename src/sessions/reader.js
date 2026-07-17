import { createReadStream, statSync } from 'fs'
import { createInterface } from 'readline'

export function cwdFromSessionsDir(dir) {
  const name = dir.split('/projects/')[1]?.replace(/\/$/, '') ?? ''
  return name.replace(/-/g, '/') || '/config/workspace'
}

export const SESSIONS_DIR = '/config/.claude/projects/-config-workspace'
export const SESSION_CWD  = '/config/workspace'

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('')
  return ''
}

export async function parseSession(filepath) {
  const messages = []; let customTitle = null; let aiTitle = null; let firstUserMsg = null
  let stat; try { stat = statSync(filepath) } catch { return { messages, customTitle, aiTitle, firstUserMsg, size: 0 } }
  const stream = createReadStream(filepath)
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const raw of rl) {
    if (!raw.trim()) continue
    let obj; try { obj = JSON.parse(raw) } catch { continue }
    const type = obj.type
    if (type === 'user') {
      const text = extractText(obj.message?.content)
      if (text && !firstUserMsg && !text.startsWith('Continue from where')) firstUserMsg = text.slice(0, 120)
      if (text) messages.push({ role: 'user', text, ts: obj.timestamp ?? null })
    }
    if (type === 'assistant') {
      const text = extractText(obj.message?.content)
      const tools = (obj.message?.content ?? []).filter(c => c?.type === 'tool_use').map(c => ({ name: c.name, input: c.input }))
      if (text || tools.length) messages.push({ role: 'assistant', text: text || '', tools, ts: obj.timestamp ?? null })
    }
    if (type === 'summary') messages.push({ role: 'summary', text: obj.summary ?? '', ts: obj.timestamp ?? null })
    const cm = raw.match(/"customTitle":"([^"]+)"/); if (cm) customTitle = cm[1]
    const am = raw.match(/"aiTitle":"([^"]+)"/); if (am) aiTitle = am[1]
  }
  return { messages, customTitle, aiTitle, firstUserMsg, size: stat.size }
}

function summarizeToolInput(name, input = {}) {
  if (!input || typeof input !== 'object') return ''
  switch (name) {
    case 'Bash': return input.command ?? ''
    case 'Read': return `${input.file_path ?? ''}${input.offset ? ` (linhas ${input.offset}-${(input.offset + (input.limit ?? 0))})` : ''}`
    case 'Edit': return `${input.file_path ?? ''}`
    case 'Write': return `${input.file_path ?? ''}`
    case 'Grep': return `${input.pattern ?? ''}${input.path ? ` em ${input.path}` : ''}`
    case 'Glob': return input.pattern ?? ''
    case 'TodoWrite': return `${(input.todos ?? []).length} itens`
    default: { try { return JSON.stringify(input).slice(0, 300) } catch { return '' } }
  }
}

export async function parseSessionTimeline(filepath) {
  let stat; try { stat = statSync(filepath) } catch { return { timeline: [] } }
  const rl = createInterface({ input: createReadStream(filepath), crlfDelay: Infinity })
  const timeline = []; const toolResults = new Map(); const toolItems = new Map()
  for await (const raw of rl) {
    if (!raw.trim()) continue
    let obj; try { obj = JSON.parse(raw) } catch { continue }
    const content = obj.message?.content; const ts = obj.timestamp ?? null
    if (obj.type === 'summary') { timeline.push({ kind: 'summary', text: obj.summary ?? '', ts }); continue }
    if (obj.type === 'user') {
      if (Array.isArray(content)) {
        let hadResult = false
        for (const c of content) {
          if (c?.type === 'tool_result') {
            hadResult = true
            const out = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(x => x?.text ?? '').join('\n') : ''
            toolResults.set(c.tool_use_id, out)
            if (toolItems.has(c.tool_use_id)) toolItems.get(c.tool_use_id).output = out.slice(0, 4000)
          }
        }
        if (hadResult) continue
      }
      const text = extractText(content)
      if (text && !text.startsWith('Continue from where')) timeline.push({ kind: 'user', text, ts })
      continue
    }
    if (obj.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'text' && c.text?.trim()) timeline.push({ kind: 'say', text: c.text, ts })
        else if (c?.type === 'thinking' && c.thinking?.trim()) timeline.push({ kind: 'thinking', text: c.thinking, ts })
        else if (c?.type === 'tool_use') {
          const item = { kind: 'tool', name: c.name, input: summarizeToolInput(c.name, c.input), output: toolResults.get(c.id) ?? null, ts, todos: c.name === 'TodoWrite' ? (c.input?.todos || []).map(t => ({ c: t.content, s: t.status })) : undefined }
          toolItems.set(c.id, item); timeline.push(item)
        }
      }
    }
  }
  return { timeline: dedupConsecutive(timeline), size: stat.size }
}

function dedupConsecutive(timeline) {
  const out = []
  for (const item of timeline) {
    const prev = out[out.length - 1]
    if (prev && prev.kind === item.kind && item.kind === 'say' && prev.text === item.text) continue
    out.push(item)
  }
  return out
}

const TAIL_BYTES = 600_000
export async function tailParseTimeline(filepath, maxItems = 80) {
  let stat; try { stat = statSync(filepath) } catch { return { timeline: [], size: 0, partial: false } }
  const startByte = Math.max(0, stat.size - TAIL_BYTES); const partial = startByte > 0
  const stream = createReadStream(filepath, { start: startByte })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const rawLines = []; for await (const line of rl) { if (line.trim()) rawLines.push(line) }
  const lines = partial ? rawLines.slice(1) : rawLines
  const toolResults = new Map(); const toolItems = new Map(); const timeline = []
  for (const raw of lines) {
    let obj; try { obj = JSON.parse(raw) } catch { continue }
    const content = obj.message?.content; const ts = obj.timestamp ?? null
    if (obj.type === 'summary') { timeline.push({ kind: 'summary', text: obj.summary ?? '', ts }); continue }
    if (obj.type === 'user') {
      if (Array.isArray(content)) {
        let hadResult = false
        for (const c of content) {
          if (c?.type === 'tool_result') {
            hadResult = true
            const out = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(x => x?.text ?? '').join('\n') : ''
            toolResults.set(c.tool_use_id, out)
            if (toolItems.has(c.tool_use_id)) toolItems.get(c.tool_use_id).output = out.slice(0, 4000)
          }
        }
        if (hadResult) continue
      }
      const txt = extractText(content)
      if (txt && !txt.startsWith('Continue from where')) timeline.push({ kind: 'user', text: txt, ts })
      continue
    }
    if (obj.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'text' && c.text?.trim()) timeline.push({ kind: 'say', text: c.text, ts })
        else if (c?.type === 'thinking' && c.thinking?.trim()) timeline.push({ kind: 'thinking', text: c.thinking, ts })
        else if (c?.type === 'tool_use') {
          const item = { kind: 'tool', name: c.name, input: summarizeToolInput(c.name, c.input), output: toolResults.get(c.id) ?? null, ts, todos: c.name === 'TodoWrite' ? (c.input?.todos || []).map(t => ({ c: t.content, s: t.status })) : undefined }
          toolItems.set(c.id, item); timeline.push(item)
        }
      }
    }
  }
  const deduped = dedupConsecutive(timeline)
  return { timeline: deduped.length > maxItems ? deduped.slice(-maxItems) : deduped, size: stat.size, partial }
}

export async function readNewLines(filepath, fromByte) {
  let stat; try { stat = statSync(filepath) } catch { return { lines: [], newPos: fromByte } }
  if (stat.size <= fromByte) return { lines: [], newPos: fromByte }
  const stream = createReadStream(filepath, { start: fromByte })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const lines = []; for await (const line of rl) { if (line.trim()) lines.push(line) }
  return { lines, newPos: stat.size }
}

export function parseLine(raw) {
  let obj; try { obj = JSON.parse(raw) } catch { return null }
  if (obj.type === 'user') { const text = extractText(obj.message?.content); if (!text) return null; return { role: 'user', text, ts: obj.timestamp ?? null } }
  if (obj.type === 'assistant') { const text = extractText(obj.message?.content); const tools = (obj.message?.content ?? []).filter(c => c?.type === 'tool_use').map(c => ({ name: c.name })); if (!text && !tools.length) return null; return { role: 'assistant', text: text || '', tools, ts: obj.timestamp ?? null } }
  if (obj.type === 'summary') return { role: 'summary', text: obj.summary ?? '', ts: obj.timestamp ?? null }
  return null
}

export function parseLineItems(raw) {
  let obj; try { obj = JSON.parse(raw) } catch { return [] }
  const ts = obj.timestamp ?? null; const out = []
  if (obj.type === 'summary') return [{ kind: 'summary', ts }]
  const content = obj.message?.content
  if (obj.type === 'user') {
    if (Array.isArray(content)) {
      let hadResult = false
      for (const c of content) {
        if (c?.type === 'tool_result') { hadResult = true; const o = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(x => x?.text ?? '').join('\n') : ''; out.push({ kind: 'tool_output', id: c.tool_use_id, output: String(o).slice(0, 4000) }) }
      }
      if (hadResult) return out
    }
    const text = extractText(content)
    if (text && !text.startsWith('Continue from where')) out.push({ kind: 'user', text, ts })
    return out
  }
  if (obj.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) out.push({ kind: 'say', text: c.text, ts })
      else if (c?.type === 'thinking' && c.thinking?.trim()) out.push({ kind: 'thinking', text: c.thinking, ts })
      else if (c?.type === 'tool_use') out.push({ kind: 'tool', id: c.id, name: c.name, input: summarizeToolInput(c.name, c.input), output: null, ts, todos: c.name === 'TodoWrite' ? (c.input?.todos || []).map(t => ({ c: t.content, s: t.status })) : undefined })
    }
  }
  return out
}
