import { execa } from 'execa'
import { createLogger } from '../../logger.js'
const logger = createLogger('terminal-local')

export const name = 'local'

export async function exec(cmd, { cwd, timeout = 30000, env } = {}) {
  logger.debug({ cmd: cmd.slice(0, 80) }, 'local exec')
  const result = await execa('bash', ['-c', cmd], {
    cwd: cwd ?? process.env.WORKSPACE_DIR ?? '/config/workspace',
    timeout,
    env: { ...process.env, ...env },
    reject: false,
  })
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
