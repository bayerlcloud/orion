/**
 * LSP Client — conecta a um language server via stdio e expõe hover, definition,
 * references, diagnostics. Suporte a múltiplos servidores concorrentes (por rootPath).
 */
import { spawn } from 'child_process'
import { createLogger } from '../logger.js'

const logger = createLogger('lsp')
const _clients = new Map()

export class LspClient {
  #proc = null
  #msgId = 0
  #pending = new Map()
  #buf = ''
  #rootUri
  #initialized = false
  #initPromise = null

  constructor(cmd, args = [], rootPath = '/config/workspace') {
    this.cmd = cmd
    this.args = args
    this.#rootUri = `file://${rootPath}`
    this.rootPath = rootPath
  }

  async connect() {
    if (this.#proc) return
    this.#proc = spawn(this.cmd, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    this.#proc.stdout.on('data', chunk => this.#onData(chunk.toString()))
    this.#proc.stderr.on('data', d => logger.debug({ msg: d.toString().slice(0, 120) }, 'lsp stderr'))
    this.#proc.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'lsp server exited')
      this.#proc = null
      this.#initialized = false
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer)
        reject(new Error('LSP server exited'))
      }
      this.#pending.clear()
    })
    this.#proc.on('error', err => {
      logger.error({ err, cmd: this.cmd }, 'lsp server error')
    })
    this.#initPromise = this.#initialize()
    await this.#initPromise
  }

  disconnect() {
    if (!this.#proc) return
    this.#notify('exit')
    this.#proc.kill('SIGTERM')
    this.#proc = null
    this.#initialized = false
  }

  #send(method, params) {
    if (!this.#proc) throw new Error('LSP não conectado')
    const id = ++this.#msgId
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`
    this.#proc.stdin.write(header + msg)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`LSP timeout: ${method}`))
      }, 15_000)
      this.#pending.set(id, { resolve, reject, timer })
    })
  }

  #notify(method, params = {}) {
    if (!this.#proc) return
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`
    this.#proc.stdin.write(header + msg)
  }

  #onData(chunk) {
    this.#buf += chunk
    while (true) {
      const headerEnd = this.#buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const header = this.#buf.slice(0, headerEnd)
      const lenMatch = header.match(/Content-Length:\s*(\d+)/i)
      if (!lenMatch) { this.#buf = this.#buf.slice(headerEnd + 4); continue }
      const len = parseInt(lenMatch[1])
      const start = headerEnd + 4
      if (this.#buf.length < start + len) break
      const body = this.#buf.slice(start, start + len)
      this.#buf = this.#buf.slice(start + len)
      try {
        const msg = JSON.parse(body)
        if (msg.id !== undefined && this.#pending.has(msg.id)) {
          const { resolve, reject, timer } = this.#pending.get(msg.id)
          clearTimeout(timer)
          this.#pending.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
          else resolve(msg.result)
        }
      } catch (err) {
        logger.warn({ err }, 'lsp parse error')
      }
    }
  }

  async #initialize() {
    const result = await this.#send('initialize', {
      processId: process.pid,
      rootUri: this.#rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          publishDiagnostics: {},
        },
        workspace: { configuration: false },
      },
      initializationOptions: {},
    })
    this.#notify('initialized', {})
    this.#initialized = true
    logger.info({ server: this.cmd, rootUri: this.#rootUri }, 'lsp inicializado')
    return result
  }

  async openFile(uri, text, languageId = 'typescript') {
    await this.#initPromise
    this.#notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text }
    })
  }

  async hover(uri, line, character) {
    await this.#initPromise
    return this.#send('textDocument/hover', { textDocument: { uri }, position: { line, character } })
  }

  async definition(uri, line, character) {
    await this.#initPromise
    return this.#send('textDocument/definition', { textDocument: { uri }, position: { line, character } })
  }

  async references(uri, line, character) {
    await this.#initPromise
    return this.#send('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    })
  }

  async diagnostics(uri) {
    await this.#initPromise
    return this.#send('textDocument/diagnostic', { textDocument: { uri } })
  }

  isConnected() { return !!this.#proc && this.#initialized }
}

export function getLspClient(cmd, args = ['--stdio'], rootPath = '/config/workspace') {
  const key = `${cmd}:${rootPath}`
  if (!_clients.has(key)) {
    const client = new LspClient(cmd, args, rootPath)
    _clients.set(key, client)
    client.connect().catch(err => {
      logger.warn({ err, cmd }, 'lsp connect falhou (server provavelmente não instalado)')
      _clients.delete(key)
    })
  }
  return _clients.get(key)
}

export function listLspClients() {
  return [..._clients.entries()].map(([key, c]) => ({
    key,
    cmd: c.cmd,
    rootPath: c.rootPath,
    connected: c.isConnected(),
  }))
}
