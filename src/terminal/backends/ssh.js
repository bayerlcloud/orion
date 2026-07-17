import { execa } from 'execa'
import { createLogger } from '../../logger.js'
const logger = createLogger('terminal-ssh')

export const name = 'ssh'

export async function exec(cmd, { host, user = 'root', keyPath, timeout = 60000 } = {}) {
  if (!host) throw new Error('ssh backend: host obrigatório')
  logger.debug({ cmd: cmd.slice(0, 80), host }, 'ssh exec')
  const sshArgs = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    ...(keyPath ? ['-i', keyPath] : []),
    `${user}@${host}`,
    cmd,
  ]
  const result = await execa('ssh', sshArgs, { timeout, reject: false })
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
