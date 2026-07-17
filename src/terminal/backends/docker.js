import { execa } from 'execa'
import { createLogger } from '../../logger.js'
const logger = createLogger('terminal-docker')

export const name = 'docker'
const DEFAULT_IMAGE = process.env.DOCKER_SANDBOX_IMAGE ?? 'alpine:3.19'

export async function exec(cmd, { cwd, timeout = 30000, env = {} } = {}) {
  logger.debug({ cmd: cmd.slice(0, 80), image: DEFAULT_IMAGE }, 'docker exec')
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const result = await execa('docker', [
    'run', '--rm',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--memory', '256m',
    '--pids-limit', '50',
    '--tmpfs', '/tmp:size=64m',
    ...envArgs,
    DEFAULT_IMAGE,
    'sh', '-c', cmd,
  ], { timeout, reject: false })
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
