import * as local  from './backends/local.js'
import * as docker from './backends/docker.js'
import * as ssh    from './backends/ssh.js'
import { createLogger } from '../logger.js'
const logger = createLogger('terminal')

const BACKENDS = { local, docker, ssh }
const DEFAULT_BACKEND = process.env.TERMINAL_BACKEND ?? 'local'

export async function execute(cmd, options = {}) {
  const backendName = options.backend ?? DEFAULT_BACKEND
  const backend = BACKENDS[backendName]
  if (!backend) throw new Error(`Backend desconhecido: ${backendName}. Disponíveis: ${Object.keys(BACKENDS).join(', ')}`)

  const start = Date.now()
  logger.info({ backend: backendName, cmd: cmd.slice(0, 100) }, 'executando')
  const result = await backend.exec(cmd, options)
  logger.info({ backend: backendName, exitCode: result.exitCode, ms: Date.now() - start }, 'concluído')
  return result
}

export function listBackends() {
  return Object.keys(BACKENDS)
}
